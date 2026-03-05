import 'dotenv/config'
import express from 'express'
import multer from 'multer'
import cors from 'cors'
import { createClient } from '@supabase/supabase-js'
import { ingestDocument } from './getdocfile.js'

const app = express()
const port = process.env.PORT || 3000

// ── Lazy Supabase client ──────────────────────────────────────────────────────
let _supabase = null
function getSupabase() {
  if (!_supabase) {
    _supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)
  }
  return _supabase
}

app.use(cors())
app.use(express.json())

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = file.originalname.split('.').pop().toLowerCase()
    if (['docx', 'txt'].includes(ext)) cb(null, true)
    else cb(new Error('Only .docx and .txt files are allowed.'))
  }
})

app.get('/', (_req, res) => res.json({ status: 'ok' }))

// ── GET /documents — list files from Lesson_Files bucket ─────────────────────
app.get('/documents', async (_req, res) => {
  try {
    const supabase = getSupabase()
    const { data, error } = await supabase
      .storage
      .from('Lesson_Files')
      .list('', { sortBy: { column: 'created_at', order: 'desc' } })

    if (error) return res.status(500).json({ error: error.message })

    const files = (data || [])
      .filter(f => f.name !== '.emptyFolderPlaceholder')
      .map(f => ({
        name: f.name,
        size: f.metadata?.size || 0,
        created_at: f.created_at,
        url: supabase.storage.from('Lesson_Files').getPublicUrl(f.name).data.publicUrl,
      }))

    res.json({ files })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── POST /documents/upload ────────────────────────────────────────────────────
app.post('/documents/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file received.' })

    const supabase = getSupabase()
    const fileName = req.file.originalname
    const fileType = fileName.split('.').pop().toLowerCase()
    const buffer = req.file.buffer
    const mimeType = req.file.mimetype

    console.log(`[upload] Received: ${fileName}`)

    // Step 1: Save raw file to Lesson_Files bucket
    const { error: storageError } = await supabase
      .storage.from('Lesson_Files')
      .upload(fileName, buffer, { contentType: mimeType, upsert: true })

    if (storageError) return res.status(500).json({ error: storageError.message })
    console.log('[upload] ✅ Raw file saved.')

    // Step 2: Run ingestion pipeline
    const result = await ingestDocument(buffer, fileName, fileType)
    console.log(`[upload] ✅ Done. chunks=${result.chunkCount} images=${result.imageCount}`)

    res.status(201).json({
      message: 'Document uploaded and processed successfully.',
      file_name: fileName,
      chunk_count: result.chunkCount,
      image_count: result.imageCount,
    })

  } catch (err) {
    console.error('[upload] Error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

app.listen(port, () => {
  console.log(`\n🚀 Backend running on http://localhost:${port}\n`)
})