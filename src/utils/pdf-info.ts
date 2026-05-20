import { readFile } from "node:fs/promises";
import { inflateSync } from "node:zlib";
import type { IPdfInfoExtractor, PdfMetadata } from "../types/index.js";

export class PdfInfoExtractor implements IPdfInfoExtractor {
  async getMetadataFromFile(filePath: string): Promise<PdfMetadata> {
    const buffer = await readFile(filePath);
    const pageCount = extractPageCount(buffer);
    return { pageCount };
  }
}

export function extractPageCount(buffer: Buffer): number {
  const text = buffer.toString("latin1");

  const rawCount = findMaxPageCount(text);
  if (rawCount > 0) return rawCount;

  const decompressed = decompressFlateStreams(text, buffer);
  if (decompressed.length > 0) {
    const decompCount = findMaxPageCount(decompressed);
    if (decompCount > 0) return decompCount;
  }

  const allText = decompressed.length > 0 ? decompressed : text;
  const pageMatches = allText.match(/\/Type\s*\/Page\b(?!s)/g);
  return pageMatches ? pageMatches.length : 0;
}

function findMaxPageCount(text: string): number {
  let maxCount = 0;
  const regex = /\/Type\s*\/Pages\b/g;
  let match;

  while ((match = regex.exec(text)) !== null) {
    const after = text.substring(match.index, match.index + 2000);
    const countMatch = after.match(/\/Count\s+(\d+)/);
    if (countMatch && countMatch[1]) {
      const count = parseInt(countMatch[1], 10);
      if (count > maxCount) maxCount = count;
    }
  }

  return maxCount;
}

function decompressFlateStreams(text: string, buffer: Buffer): string {
  const parts: string[] = [];
  const streamRegex = /stream\r?\n/g;
  let match;

  while ((match = streamRegex.exec(text)) !== null) {
    const streamStart = match.index + match[0].length;

    const prevObj = text.lastIndexOf("obj", match.index);
    if (prevObj === -1) continue;
    const header = text.substring(prevObj, match.index);
    if (!/\/Filter\s*(\/FlateDecode|\[\s*\/FlateDecode)/.test(header)) continue;

    const endstreamIdx = text.indexOf("endstream", streamStart);
    if (endstreamIdx === -1) continue;

    let streamEnd = endstreamIdx;
    while (streamEnd > streamStart && (text[streamEnd - 1] === "\n" || text[streamEnd - 1] === "\r")) {
      streamEnd--;
    }

    const streamData = buffer.subarray(streamStart, streamEnd);

    try {
      parts.push(inflateSync(streamData).toString("latin1"));
    } catch {
      continue;
    }
  }

  return parts.join("\n");
}
