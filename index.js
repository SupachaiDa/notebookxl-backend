import 'dotenv/config'
import express from 'express'
import multer from 'multer'
import cors from 'cors'
import { createClient } from '@supabase/supabase-js'
import { ingestDocument } from './getdocfile.js'
import { handleChat, getChatHistory } from './chat.js'
import { verifyToken, isAdmin } from './auth.js'

const app  = express()
const port = process.env.PORT || 3000

let _supabase = null
function getSupabase() {
  if (!_supabase) _supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)
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

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/', (_req, res) => res.json({ status: 'ok' }))

// ── GET /documents — public list of files ─────────────────────────────────────
app.get('/documents', async (_req, res) => {
  try {
    const supabase = getSupabase()
    const { data, error } = await supabase
      .storage.from('Lesson_Files')
      .list('', { sortBy: { column: 'created_at', order: 'desc' } })

    if (error) return res.status(500).json({ error: error.message })

    const files = (data || [])
      .filter(f => f.name !== '.emptyFolderPlaceholder')
      .map(f => ({
        name:       f.name,
        size:       f.metadata?.size || 0,
        created_at: f.created_at,
        url:        supabase.storage.from('Lesson_Files').getPublicUrl(f.name).data.publicUrl,
      }))

    res.json({ files })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── POST /documents/upload — admin only ───────────────────────────────────────
app.post('/documents/upload', verifyToken, isAdmin, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file received.' })

    const supabase = getSupabase()
    const fileName = req.file.originalname
    const fileType = fileName.split('.').pop().toLowerCase()
    const buffer   = req.file.buffer
    const mimeType = req.file.mimetype

    console.log(`[upload] Admin ${req.user.email} uploading: ${fileName}`)

    const { error: storageError } = await supabase
      .storage.from('Lesson_Files')
      .upload(fileName, buffer, { contentType: mimeType, upsert: true })

    if (storageError) return res.status(500).json({ error: storageError.message })

    const result = await ingestDocument(buffer, fileName, fileType)
    console.log(`[upload] ✅ chunks=${result.chunkCount} images=${result.imageCount}`)

    res.status(201).json({
      message:     'Document uploaded and processed successfully.',
      file_name:   fileName,
      chunk_count: result.chunkCount,
      image_count: result.imageCount,
    })
  } catch (err) {
    console.error('[upload] Error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── POST /chat — logged in users only ─────────────────────────────────────────
app.post('/chat', verifyToken, async (req, res) => {
  try {
    const { question, file_name } = req.body
    if (!question) return res.status(400).json({ error: 'question is required.' })

    console.log(`[chat] ${req.user.email}: "${question}"`)
    const result = await handleChat(question, req.user.id, file_name || null)

    res.json(result)
  } catch (err) {
    console.error('[chat] Error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── GET /chat/history — load full history for logged in user ──────────────────
app.get('/chat/history', verifyToken, async (req, res) => {
  try {
    const history = await getChatHistory(req.user.id)
    res.json({ history })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.listen(port, () => {
  console.log(`\n🚀 notebookXL backend — http://localhost:${port}`)
  console.log(`   GET  /documents         — list files (public)`)
  console.log(`   POST /documents/upload  — upload & ingest (admin only)`)
  console.log(`   POST /chat              — ask AI (auth required)`)
  console.log(`   GET  /chat/history      — load history (auth required)\n`)
})
