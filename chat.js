/**
 * chat.js
 * RAG chat: load history → embed question → search chunks → answer with OpenAI
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
const AI_MAX_TOKENS   = 1024
const SEARCH_TOP_K    = 5
const HISTORY_LIMIT   = 10   // last N messages to include as context
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
// Load recent chat history for a user (using service role key — bypasses RLS)
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

  // Reverse so oldest first (correct order for OpenAI messages array)
  return (data || []).reverse()
}

// ─────────────────────────────────────────────────────────────────────────────
// Save a message to chat_messages
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
// ─────────────────────────────────────────────────────────────────────────────
export async function handleChat(question, userId, fileName = null) {
  const supabase = getSupabase()

  // 1. Load chat history
  const history = await loadHistory(userId)

  // 2. Embed the question
  const embedding = await embedOne(question)

  // 3. Search similar chunks
  const { data: chunks, error } = await supabase.rpc('match_lesson_chunks', {
    query_embedding: embedding,
    match_count:     SEARCH_TOP_K,
    filter_file:     fileName || null,
  })

  if (error) throw new Error(`Vector search failed: ${error.message}`)

  // 4. Build context from chunks
  const context = chunks && chunks.length > 0
    ? chunks.map((c, i) => `[Source ${i + 1}] (${c.file_name})\n${c.content}`).join('\n\n---\n\n')
    : 'No relevant document excerpts found.'

  // 5. Build messages array for OpenAI:
  //    system prompt + history + current question with context
  const messages = [
    {
      role:    'system',
      content: `You are a helpful assistant for an e-learning platform.
Answer questions using the document excerpts provided.
- Cite [Source N] for each fact you use.
- If the answer is not in the excerpts, say so clearly.
- Use the conversation history to give contextual, smooth replies.
- Never make up information.`,
    },
    // Inject previous messages as conversation history
    ...history.map(m => ({ role: m.role, content: m.content })),
    // Current question with retrieved context
    {
      role:    'user',
      content: `Document excerpts:\n\n${context}\n\n---\n\nQuestion: ${question}`,
    },
  ]

  // 6. Ask OpenAI
  const openai     = getOpenAI()
  const completion = await openai.chat.completions.create({
    model:      AI_MODEL,
    max_tokens: AI_MAX_TOKENS,
    messages,
  })

  const answer = completion.choices[0].message.content

  // 7. Collect unique image URLs
  const images = chunks && chunks.length > 0
    ? [...new Set(chunks.flatMap(c => c.img_url ? c.img_url.split(', ') : []).filter(Boolean))]
    : []

  // 8. Save both messages to history
  await saveMessage(userId, 'user',      question, [])
  await saveMessage(userId, 'assistant', answer,   images)

  return {
    answer,
    images,
    sources: (chunks || []).map(c => ({
      file_name:   c.file_name,
      chunk_index: c.chunk_index,
      similarity:  c.similarity,
      preview:     c.content.slice(0, 150) + '…',
    })),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Get full chat history for a user
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
