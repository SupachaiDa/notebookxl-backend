/**
 * chunker.js
 * Splits text into overlapping, sentence-aware chunks.
 */

/**
 * @param {string} text        - Raw document text
 * @param {number} chunkSize   - Target characters per chunk  (default 800)
 * @param {number} overlap     - Overlap characters between chunks (default 150)
 * @returns {string[]}
 */
export function chunkText(text, chunkSize = 800, overlap = 150) {
  // Normalize whitespace & line breaks
  const normalized = text
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // Split on sentence-ending punctuation to avoid cutting mid-sentence
  const sentences = normalized.match(/[^.!?\n]+[.!?\n]+|[^.!?\n]+$/g) ?? [normalized];

  const chunks = [];
  let current = '';

  for (const raw of sentences) {
    const sentence = raw.trim();
    if (!sentence) continue;

    if (current.length + sentence.length > chunkSize && current.length > 0) {
      chunks.push(current.trim());
      // Start next chunk with tail of previous for context continuity
      current = current.slice(-overlap) + ' ' + sentence;
    } else {
      current += (current ? ' ' : '') + sentence;
    }
  }

  if (current.trim()) chunks.push(current.trim());

  // Drop chunks that are too short to be meaningful
  return chunks.filter(c => c.length > 40);
}
