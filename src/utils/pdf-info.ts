import { readFile } from "node:fs/promises";
import { inflateSync } from "node:zlib";
import type { IPdfInfoExtractor, PdfMetadata } from "../types/index.js";

const MAX_DECOMPRESSED_STREAM_SIZE = 256 * 1024;

const MAX_TOTAL_BUDGET = 2 * 1024 * 1024;

export class PdfInfoExtractor implements IPdfInfoExtractor {
  async getMetadataFromFile(filePath: string): Promise<PdfMetadata> {
    const buffer = await readFile(filePath);
    const pageCount = extractPageCount(buffer);
    return { pageCount };
  }
}

export function extractPageCount(buffer: Buffer): number {
  const text = buffer.toString("latin1");

  const rawCount = findLastPageCount(text);
  if (rawCount > 0) return rawCount;

  let totalDecompressed = 0;
  for (const streamText of flateStreamIterator(text, buffer)) {
    totalDecompressed += streamText.length;
    if (totalDecompressed > MAX_TOTAL_BUDGET) break;

    const count = findLastPageCount(streamText);
    if (count > 0) return count;

    const pageMatches = streamText.match(/\/Type\s*\/Page\b(?!s)/g);
    if (pageMatches && pageMatches.length > 0) return pageMatches.length;
  }

  const pageMatches = text.match(/\/Type\s*\/Page\b(?!s)/g);
  return pageMatches ? pageMatches.length : 0;
}

// Returns the last /Count value found in /Type /Pages nodes rather than the
// maximum. Incremental-update PDFs append a revised page tree at the end of
// the file; the last /Count is more likely to reflect the current state than
// the maximum, which can pick up stale orphaned subtrees.
function findLastPageCount(text: string): number {
  let lastCount = 0;
  const regex = /\/Type\s*\/Pages\b/g;
  let match;

  while ((match = regex.exec(text)) !== null) {
    const after = text.substring(match.index, match.index + 2000);
    const countMatch = after.match(/\/Count\s+(\d+)/);
    if (countMatch && countMatch[1]) {
      const count = parseInt(countMatch[1], 10);
      if (count > 0) lastCount = count;
    }
  }

  return lastCount;
}

// Yields decompressed FlateDecode streams one at a time so the caller can
// stop as soon as the target data is found, without materializing every stream
// into a single concatenated string. Memory is bounded by:
//   - maxOutputLength: caps each stream's decompressed size (zip-bomb defence)
//   - MAX_TOTAL_BUDGET: caps cumulative decompressed bytes across all streams
function* flateStreamIterator(
  text: string,
  buffer: Buffer,
): Generator<string> {
  const streamRegex = /stream\r?\n/g;
  let match;

  while ((match = streamRegex.exec(text)) !== null) {
    const streamStart = match.index + match[0].length;

    const prevObj = text.lastIndexOf("obj", match.index);
    if (prevObj === -1) continue;
    const header = text.substring(prevObj, match.index);
    if (!/\/Filter\s*(\/FlateDecode|\[\s*\/FlateDecode)/.test(header))
      continue;

    const endstreamIdx = text.indexOf("endstream", streamStart);
    if (endstreamIdx === -1) continue;

    let streamEnd = endstreamIdx;
    while (
      streamEnd > streamStart &&
      (text[streamEnd - 1] === "\n" || text[streamEnd - 1] === "\r")
    ) {
      streamEnd--;
    }

    const streamData = buffer.subarray(streamStart, streamEnd);

    try {
      const decompressed = inflateSync(streamData, {
        maxOutputLength: MAX_DECOMPRESSED_STREAM_SIZE,
      });
      yield decompressed.toString("latin1");
    } catch {
      continue;
    }
  }
}
