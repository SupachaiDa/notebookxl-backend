/**
 * embedder.js
 * Wraps OpenAI text-embedding-3-small with automatic batching.
 */

import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const EMBED_MODEL = 'text-embedding-3-small';
const BATCH_SIZE  = 100; // OpenAI limit per request

/**
 * Embed an array of strings.
 * Returns float[][] in the same order as input.
 *
 * @param {string[]} texts
 * @returns {Promise<number[][]>}
 */
export async function embedTexts(texts) {
  const allEmbeddings = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);

    const response = await openai.embeddings.create({
      model: EMBED_MODEL,
      input: batch,
    });

    // Preserve original order (OpenAI returns them indexed)
    const sorted = response.data
      .sort((a, b) => a.index - b.index)
      .map(d => d.embedding);

    allEmbeddings.push(...sorted);
  }

  return allEmbeddings;
}

/**
 * Embed a single string.
 * @param {string} text
 * @returns {Promise<number[]>}
 */
export async function embedOne(text) {
  const [embedding] = await embedTexts([text]);
  return embedding;
}

export { openai };
