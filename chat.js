/**
 * chat.js
 * Handles RAG chat: embed question → search lesson_chunk → answer with AI
 *
 * 🔧 TO CHANGE AI MODEL — only edit the CONFIG block below:
 */

import OpenAI from 'openai'
import { createClient } from '@supabase/supabase-js'
import { embedOne } from './embedder.js'

// ─────────────────────────────────────────────────────────────────────────────
// 🔧 CONFIG — change model here anytime
// ─────────────────────────────────────────────────────────────────────────────
const AI_MODEL = 'gpt-4o-mini'   // swap to 'gpt-4o' for smarter answers
const AI_MAX_TOKENS = 1024
const SEARCH_TOP_K = 5               // number of chunks to retrieve
// ─────────────────────────────────────────────────────────────────────────────

// ── Lazy clients ──────────────────────────────────────────────────────────────
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
// Main chat handler
// ─────────────────────────────────────────────────────────────────────────────
export async function handleChat(question, fileName = null) {
  const supabase = getSupabase()

  // 1. Embed the question
  const embedding = await embedOne(question)

  // 2. Search similar chunks via Supabase RPC
  const { data: chunks, error } = await supabase.rpc('match_lesson_chunks', {
    query_embedding: embedding,
    match_count: SEARCH_TOP_K,
    filter_file: fileName || null,
  })

  if (error) throw new Error(`Vector search failed: ${error.message}`)

  if (!chunks || chunks.length === 0) {
    return {
      answer: "I couldn't find relevant information in the documents.",
      images: [],
      sources: [],
    }
  }

  // 3. Build context for the AI
  const context = chunks
    .map((c, i) => `[Source ${i + 1}] (${c.file_name})\n${c.content}`)
    .join('\n\n---\n\n')

  // 4. Ask OpenAI
  const openai = getOpenAI()
  const completion = await openai.chat.completions.create({
    model: AI_MODEL,
    max_tokens: AI_MAX_TOKENS,
    messages: [
      {
        role: 'system',
        content: `You are a helpful assistant. Answer questions using ONLY the document excerpts provided.
- Cite [Source N] for each fact you use.
- If the answer is not in the excerpts, say so clearly.
- Never make up information.`,
      },
      {
        role: 'user',
        content: `Document excerpts:\n\n${context}\n\n---\n\nQuestion: ${question}`,
      }
    ]
  })

  const answer = completion.choices[0].message.content

  // 5. Collect unique image URLs from matched chunks
  const images = [...new Set(
    chunks
      .flatMap(c => c.img_url ? c.img_url.split(', ') : [])
      .filter(Boolean)
  )]

  return {
    answer,
    images,
    sources: chunks.map(c => ({
      file_name: c.file_name,
      chunk_index: c.chunk_index,
      similarity: c.similarity,
      preview: c.content.slice(0, 150) + '…',
    })),
  }
}