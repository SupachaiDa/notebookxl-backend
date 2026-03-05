/**
 * chat.js
 * Handles RAG chat: embed question → search lesson_chunk → answer with Claude
 */

import Anthropic from '@anthropic-ai/sdk'
import { createClient } from '@supabase/supabase-js'
import { embedOne } from './embedder.js'

// ── Lazy clients ──────────────────────────────────────────────────────────────
let _supabase = null
function getSupabase() {
  if (!_supabase) _supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)
  return _supabase
}

let _anthropic = null
function getAnthropic() {
  if (!_anthropic) _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  return _anthropic
}

// ─────────────────────────────────────────────────────────────────────────────
// Main chat handler — call this from index.js route
// ─────────────────────────────────────────────────────────────────────────────
export async function handleChat(question, fileName = null) {
  const supabase = getSupabase()

  // 1. Embed the question using OpenAI
  const embedding = await embedOne(question)

  // 2. Search similar chunks via Supabase RPC
  const { data: chunks, error } = await supabase.rpc('match_lesson_chunks', {
    query_embedding: embedding,
    match_count:     5,
    filter_file:     fileName || null,
  })

  if (error) throw new Error(`Vector search failed: ${error.message}`)

  if (!chunks || chunks.length === 0) {
    return {
      answer:  "I couldn't find relevant information in the documents.",
      images:  [],
      sources: [],
    }
  }

  // 3. Build context block for Claude
  const context = chunks
    .map((c, i) => `[Source ${i + 1}] (${c.file_name})\n${c.content}`)
    .join('\n\n---\n\n')

  // 4. Ask Claude
  const anthropic = getAnthropic()
  const message   = await anthropic.messages.create({
    model:      'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    messages: [
      {
        role:    'user',
        content: `You are a helpful assistant. Answer the question using ONLY the document excerpts below.
- Cite [Source N] for each fact you use.
- If the answer is not in the excerpts, say so clearly.
- Never make up information.

Document excerpts:

${context}

---

Question: ${question}`,
      }
    ]
  })

  const answer = message.content[0].text

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
      file_name:   c.file_name,
      chunk_index: c.chunk_index,
      similarity:  c.similarity,
      preview:     c.content.slice(0, 150) + '…',
    })),
  }
}
