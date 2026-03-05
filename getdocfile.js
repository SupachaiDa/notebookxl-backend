import mammoth from 'mammoth'
import { createClient } from '@supabase/supabase-js'
import { chunkText } from './chunker.js'
import { embedTexts } from './embedder.js'

const CHUNK_SIZE = 800
const CHUNK_OVERLAP = 150
const DB_BATCH_SIZE = 50
const IMAGE_BUCKET = 'Lesson_Images'

// ── Lazy Supabase client ──────────────────────────────────────────────────────
let _supabase = null
function getSupabase() {
  if (!_supabase) {
    if (!process.env.SUPABASE_URL) throw new Error('SUPABASE_URL is missing.')
    if (!process.env.SUPABASE_KEY) throw new Error('SUPABASE_KEY is missing.')
    _supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)
  }
  return _supabase
}

// ─────────────────────────────────────────────────────────────────────────────
// Extract ordered blocks (text + images) from .docx
// ─────────────────────────────────────────────────────────────────────────────
async function extractBlocks(fileBuffer) {
  const imageBlocks = []
  let imageIndex = 0

  const { value: html } = await mammoth.convertToHtml(
    { buffer: fileBuffer },
    {
      convertImage: mammoth.images.imgElement(async (image) => {
        const buffer = await image.read()
        const contentType = image.contentType || 'image/png'
        const ext = contentType.split('/')[1] || 'png'
        const name = `img_${imageIndex++}.${ext}`
        imageBlocks.push({ type: 'image', name, buffer, contentType })
        return { src: `__image__${name}` }
      }),
    }
  )

  const orderedBlocks = []
  const tagRe = /(<p[^>]*>|<\/p>|<img[^>]*\/>|<img[^>]*>)/gi
  const pieces = html.split(tagRe).filter(s => s.trim())

  let inParagraph = false
  let textAcc = ''

  for (const piece of pieces) {
    const lower = piece.toLowerCase().trim()
    if (lower.startsWith('<p')) {
      inParagraph = true
      textAcc = ''
    } else if (lower === '</p>') {
      inParagraph = false
      const text = stripTags(textAcc).trim()
      if (text) orderedBlocks.push({ type: 'text', value: text })
      textAcc = ''
    } else if (lower.startsWith('<img')) {
      if (textAcc.trim()) {
        const text = stripTags(textAcc).trim()
        if (text) orderedBlocks.push({ type: 'text', value: text })
        textAcc = ''; inParagraph = false
      }
      const srcMatch = piece.match(/src="__image__(img_\d+\.[a-z]+)"/i)
      if (srcMatch) {
        const found = imageBlocks.find(b => b.name === srcMatch[1])
        if (found) orderedBlocks.push(found)
      }
    } else if (inParagraph) {
      textAcc += piece
    }
  }

  const remaining = stripTags(textAcc).trim()
  if (remaining) orderedBlocks.push({ type: 'text', value: remaining })

  return orderedBlocks
}

function stripTags(html) {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
}

// ─────────────────────────────────────────────────────────────────────────────
// Upload image to Supabase Storage
// ─────────────────────────────────────────────────────────────────────────────
async function uploadImage(name, buffer, contentType, docName) {
  const supabase = getSupabase()
  const folder = docName.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '_')
  const path = `${folder}/${name}`

  const { error } = await supabase
    .storage.from(IMAGE_BUCKET)
    .upload(path, buffer, { contentType, upsert: true })

  if (error) throw new Error(`Image upload failed (${name}): ${error.message}`)

  const { data: urlData } = supabase.storage.from(IMAGE_BUCKET).getPublicUrl(path)
  return urlData.publicUrl
}

// ─────────────────────────────────────────────────────────────────────────────
// Build chunks with all image URLs per chunk
// ─────────────────────────────────────────────────────────────────────────────
function buildChunksWithImages(orderedBlocks) {
  const result = []
  let textBuffer = ''
  let imgSet = new Set()

  for (const block of orderedBlocks) {
    if (block.type === 'image') {
      imgSet.add(block.url)
    } else {
      textBuffer += ' ' + block.value
      while (textBuffer.length > CHUNK_SIZE) {
        let splitAt = CHUNK_SIZE
        const sentenceEnd = textBuffer.lastIndexOf('.', CHUNK_SIZE)
        if (sentenceEnd > CHUNK_SIZE * 0.6) splitAt = sentenceEnd + 1
        const content = textBuffer.slice(0, splitAt).trim()
        if (content) result.push({ content, img_urls: [...imgSet] })
        textBuffer = textBuffer.slice(splitAt - CHUNK_OVERLAP).trim()
        imgSet = new Set()
      }
    }
  }

  if (textBuffer.trim()) result.push({ content: textBuffer.trim(), img_urls: [...imgSet] })
  return result
}

// ─────────────────────────────────────────────────────────────────────────────
// Main ingestion pipeline
// ─────────────────────────────────────────────────────────────────────────────
export async function ingestDocument(fileBuffer, fileName, fileType) {
  if (fileType === 'txt') {
    const rawText = fileBuffer.toString('utf-8')
    if (!rawText.trim()) throw new Error('File is empty.')
    const chunks = chunkText(rawText, CHUNK_SIZE, CHUNK_OVERLAP)
    const embeddings = await embedTexts(chunks)
    await insertChunks(chunks.map((content, i) => ({ content, img_urls: [], embedding: embeddings[i] })), fileName)
    return { chunkCount: chunks.length, charCount: rawText.length, imageCount: 0 }
  }

  console.log('[ingest] Extracting blocks...')
  const orderedBlocks = await extractBlocks(fileBuffer)

  console.log('[ingest] Uploading images...')
  let imageCount = 0
  for (const block of orderedBlocks) {
    if (block.type === 'image') {
      block.url = await uploadImage(block.name, block.buffer, block.contentType, fileName)
      imageCount++
      console.log(`[ingest]   ✅ ${block.name}`)
    }
  }

  const chunksWithImages = buildChunksWithImages(orderedBlocks)
  if (chunksWithImages.length === 0) throw new Error('No text content found.')
  console.log(`[ingest] ${chunksWithImages.length} chunks built.`)

  console.log('[ingest] Embedding...')
  const embeddings = await embedTexts(chunksWithImages.map(c => c.content))

  await insertChunks(
    chunksWithImages.map((c, i) => ({ content: c.content, img_urls: c.img_urls, embedding: embeddings[i] })),
    fileName
  )

  console.log('[ingest] ✅ Done.')
  return {
    chunkCount: chunksWithImages.length,
    charCount: chunksWithImages.reduce((s, c) => s + c.content.length, 0),
    imageCount,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Insert chunks — matches your exact column names
// ─────────────────────────────────────────────────────────────────────────────
async function insertChunks(chunks, fileName) {
  const supabase = getSupabase()
  for (let i = 0; i < chunks.length; i += DB_BATCH_SIZE) {
    const batch = chunks.slice(i, i + DB_BATCH_SIZE)
    const rows = batch.map((c, j) => ({
      file_name: fileName,
      chunk_index: i + j,
      content: c.content,
      embedding: c.embedding,
      img_url: c.img_urls.join(', ') || null,
    }))
    const { error } = await supabase.from('lesson_chunk').insert(rows)
    if (error) throw new Error(`Chunk insert failed: ${error.message}`)
  }
}