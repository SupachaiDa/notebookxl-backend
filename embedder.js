/**
 * embedder.js
 * Creates OpenAI client lazily so dotenv is loaded first.
 */

import OpenAI from 'openai'

let _openai = null

function getClient() {
  if (!_openai) {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY environment variable is missing.')
    }
    _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  }
  return _openai
}

const EMBED_MODEL = 'text-embedding-3-small'
const BATCH_SIZE = 100

export async function embedTexts(texts) {
  const openai = getClient()
  const allEmbeddings = []

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE)
    const response = await openai.embeddings.create({ model: EMBED_MODEL, input: batch })
    const sorted = response.data.sort((a, b) => a.index - b.index).map(d => d.embedding)
    allEmbeddings.push(...sorted)
  }

  return allEmbeddings
}

export async function embedOne(text) {
  const [embedding] = await embedTexts([text])
  return embedding
}

export { getClient as openai }