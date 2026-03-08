/**
 * chat.js
 * RAG chat with optional image understanding via OpenAI Vision.
 *
 * 🔧 TO CHANGE AI MODEL — only edit the CONFIG block below:
 */

import OpenAI from 'openai'
import { createClient } from '@supabase/supabase-js'
import { embedOne } from './embedder.js'

// ─────────────────────────────────────────────────────────────────────────────
// 🔧 CONFIG
// ─────────────────────────────────────────────────────────────────────────────
const AI_MODEL        = 'gpt-4o-mini'
const VISION_MODEL    = 'gpt-4o-mini'   // supports vision
const AI_MAX_TOKENS   = 1024
const SEARCH_TOP_K    = 5
const HISTORY_LIMIT   = 10
// ─────────────────────────────────────────────────────────────────────────────

let _supabase = null
function getSupabase() {
  if (!_supabase) _supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)
  return _supabase
}

let _openai = null
function getOpenAI() {
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  return _openai
}

// ─────────────────────────────────────────────────────────────────────────────
// Describe an image using OpenAI Vision
// imageBase64: base64 string (no data URI prefix)
// mimeType: e.g. 'image/png', 'image/jpeg'
// ─────────────────────────────────────────────────────────────────────────────
async function describeImage(imageBase64, mimeType) {
  const openai = getOpenAI()
  const response = await openai.chat.completions.create({
    model:      VISION_MODEL,
    max_tokens: 512,
    messages: [
      {
        role:    'user',
        content: [
          {
            type:      'image_url',
            image_url: { url: `data:${mimeType};base64,${imageBase64}` },
          },
          {
            type: 'text',
            text: 'Describe this image in detail. Include any text, numbers, charts, diagrams, people, objects, or notable content visible. Be thorough and factual.',
          },
        ],
      }
    ],
  })
  return response.choices[0].message.content
}

// ─────────────────────────────────────────────────────────────────────────────
// Load recent chat history
// ─────────────────────────────────────────────────────────────────────────────
async function loadHistory(userId) {
  const supabase = getSupabase()
  const { data, error } = await supabase
    .from('chat_messages')
    .select('role, content')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(HISTORY_LIMIT)
  if (error) throw new Error(`Failed to load history: ${error.message}`)
  return (data || []).reverse()
}

// ─────────────────────────────────────────────────────────────────────────────
// Save a message
// ─────────────────────────────────────────────────────────────────────────────
async function saveMessage(userId, role, content, imgUrls = []) {
  const supabase = getSupabase()
  const { error } = await supabase
    .from('chat_messages')
    .insert({
      user_id:  userId,
      role,
      content,
      img_urls: imgUrls.length > 0 ? imgUrls : null,
    })
  if (error) throw new Error(`Failed to save message: ${error.message}`)
}

// ─────────────────────────────────────────────────────────────────────────────
// Main chat handler
// question     — what the user typed
// userId       — for history
// fileName     — optional file filter
// imageBase64  — optional base64 image string (not stored, not shown to user)
// imageMime    — e.g. 'image/png'
// ─────────────────────────────────────────────────────────────────────────────
export async function handleChat(question, userId, fileName = null, imageBase64 = null, imageMime = 'image/png') {
  const supabase = getSupabase()

  // 1. If image provided, describe it first
  let imageDescription = null
  if (imageBase64) {
    console.log('[chat] Describing uploaded image via Vision...')
    imageDescription = await describeImage(imageBase64, imageMime)
    console.log('[chat] Image description ready.')
  }

  // 2. Build the full question for embedding + context
  //    (includes image description but user only sees their original question)
  const fullQuestion = imageDescription
    ? `${question}\n\n[The user also attached an image. Here is what the image shows: ${imageDescription}]`
    : question

  // 3. Load chat history
  const history = await loadHistory(userId)

  // 4. Embed the full question (with image context if any)
  const embedding = await embedOne(fullQuestion)

  // 5. Search similar chunks
  const { data: chunks, error } = await supabase.rpc('match_lesson_chunks', {
    query_embedding: embedding,
    match_count:     SEARCH_TOP_K,
    filter_file:     fileName || null,
  })
  if (error) throw new Error(`Vector search failed: ${error.message}`)

  // 6. Build document context
  const context = chunks && chunks.length > 0
    ? chunks.map((c, i) => `[Source ${i + 1}] (${c.file_name})\n${c.content}`).join('\n\n---\n\n')
    : 'No relevant document excerpts found.'

  // 7. Build messages for OpenAI
  const messages = [
    {
      role:    'system',
      content: `You are a helpful assistant for an e-learning platform.
Answer questions using the document excerpts provided.
- Cite [Source N] for each fact you use.
- If the user attached an image, use the image description to understand their question better.
- If the answer is not in the excerpts, say so clearly.
- Use the conversation history to give contextual, smooth replies.
- Never make up information.`,
    },
    ...history.map(m => ({ role: m.role, content: m.content })),
    {
      role:    'user',
      content: imageDescription
        // If image was attached, send as multimodal content so AI understands both
        ? [
            { type: 'text', text: `Document excerpts:\n\n${context}\n\n---\n\nQuestion: ${question}` },
            { type: 'image_url', image_url: { url: `data:${imageMime};base64,${imageBase64}` } },
          ]
        : `Document excerpts:\n\n${context}\n\n---\n\nQuestion: ${question}`,
    },
  ]

  // 8. Ask OpenAI
  const openai     = getOpenAI()
  const completion = await openai.chat.completions.create({
    model:      AI_MODEL,
    max_tokens: AI_MAX_TOKENS,
    messages,
  })

  const answer = completion.choices[0].message.content

  // 9. Collect image URLs from matched chunks (document images, not user's uploaded image)
  //    Build a map: url → { chunkText, visionDescription }
  const imageMap = new Map() // url → { chunk_context, vision_description }

  if (chunks && chunks.length > 0) {
    for (const chunk of chunks) {
      if (!chunk.img_url) continue
      const urls = chunk.img_url.split(', ').map(u => u.trim()).filter(Boolean)
      for (const url of urls) {
        if (!imageMap.has(url)) {
          // Use the chunk text that is most closely associated with this image as context
          imageMap.set(url, { chunk_context: chunk.content, vision_description: null })
        }
      }
    }
  }

  // 9a. Generate a caption for each image using its closest chunk context.
  //     We use GPT to turn the raw chunk text into a clean 1-2 sentence caption.
  //     No image fetch needed — the chunk text is already the most relevant context.
  await Promise.all([...imageMap.entries()].map(async ([url, meta]) => {
    try {
      const captionRes = await getOpenAI().chat.completions.create({
        model:      AI_MODEL,
        max_tokens: 100,
        messages: [{
          role:    'user',
          content: `Write a concise 1-sentence image caption for a student based on this document text.
The caption should describe what the image likely shows and why it matters.
Document text: ${meta.chunk_context.slice(0, 500)}
Respond with the caption only. No preamble, no quotes.`,
        }]
      })
      meta.vision_description = captionRes.choices[0].message.content.trim()
      console.log(`[chat] Caption OK for image in chunk`)
    } catch (err) {
      console.warn(`[chat] Caption failed:`, err.message)
      // Fallback: clean up the chunk text itself as the caption
      meta.vision_description = meta.chunk_context.replace(/\s+/g, ' ').slice(0, 150).trim() + '…'
    }
  }))

  const images             = [...imageMap.keys()]
  const image_descriptions = Object.fromEntries(
    [...imageMap.entries()].map(([url, meta]) => [url, meta.vision_description])
  )

  // 10. Save to history — store only the original question (not image description)
  await saveMessage(userId, 'user',      question, [])
  await saveMessage(userId, 'assistant', answer,   images)

  return {
    answer,
    images,
    image_descriptions, // { [url]: "caption string" }
    sources: (chunks || []).map(c => ({
      file_name:   c.file_name,
      chunk_index: c.chunk_index,
      similarity:  c.similarity,
      preview:     c.content.slice(0, 150) + '…',
    }))
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Get full chat history
// ─────────────────────────────────────────────────────────────────────────────
export async function getChatHistory(userId) {
  const supabase = getSupabase()
  const { data, error } = await supabase
    .from('chat_messages')
    .select('id, role, content, img_urls, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: true })
  if (error) throw new Error(error.message)
  return data || []
}
