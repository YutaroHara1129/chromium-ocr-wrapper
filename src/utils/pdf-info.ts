import { readFile } from "node:fs/promises";
import { inflateSync } from "node:zlib";
import type { IPdfInfoExtractor, IPdfAnalyzer, PdfMetadata, PdfAnalysis, PdfKind, OcrVerificationResult, PageVerificationStatus } from "../types/index.js";

const MAX_DECOMPRESSED_STREAM_SIZE = 1024 * 1024;

const MAX_TOTAL_BUDGET = 10 * 1024 * 1024;

export class PdfInfoExtractor implements IPdfInfoExtractor, IPdfAnalyzer {
  async getMetadataFromFile(filePath: string): Promise<PdfMetadata> {
    const buffer = await readFile(filePath);
    const pageCount = extractPageCount(buffer);
    return { pageCount };
  }

  async analyze(filePath: string): Promise<PdfAnalysis> {
    const buffer = await readFile(filePath);
    return analyzePdfContent(buffer);
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

const FONT_INDICATOR = /\/BaseFont\b/;
const IMAGE_INDICATOR = /\/Subtype\s*\/Image\b/;

export function analyzePdfContent(buffer: Buffer): PdfAnalysis {
  const text = buffer.toString("latin1");

  if (buffer.length === 0) {
    return {
      pageCount: 0,
      kind: "blank",
      hasExtractableText: false,
      hasImages: false,
      pagesNeedingOcr: 0,
    };
  }

  if (!text.startsWith("%PDF-")) {
    return {
      pageCount: 0,
      kind: "unknown",
      hasExtractableText: false,
      hasImages: false,
      pagesNeedingOcr: 0,
    };
  }

  const pageCount = extractPageCount(buffer);

  let hasExtractableText = FONT_INDICATOR.test(text);
  let hasImages = IMAGE_INDICATOR.test(text);

  if (!hasExtractableText || !hasImages) {
    let totalDecompressed = 0;
    for (const streamText of flateStreamIterator(text, buffer)) {
      totalDecompressed += streamText.length;
      if (totalDecompressed > MAX_TOTAL_BUDGET) break;

      if (!hasExtractableText && FONT_INDICATOR.test(streamText)) {
        hasExtractableText = true;
      }
      if (!hasImages && IMAGE_INDICATOR.test(streamText)) {
        hasImages = true;
      }
      if (hasExtractableText && hasImages) break;
    }
  }

  const kind = classifyPdfKind(hasExtractableText, hasImages, pageCount);
  const pagesNeedingOcr =
    kind === "image_only" || kind === "mixed" ? pageCount : 0;

  return { pageCount, kind, hasExtractableText, hasImages, pagesNeedingOcr };
}

function classifyPdfKind(
  hasText: boolean,
  hasImages: boolean,
  pageCount: number,
): PdfKind {
  if (pageCount === 0) return "blank";
  if (hasText && hasImages) return "mixed";
  if (hasText) return "text_only";
  if (hasImages) return "image_only";
  return "blank";
}


const TEXT_OPERATOR_RE = /(?:^|[\s\[\]])(?:BT|Tj|TJ|'|")/;
const XOBJECT_DO_RE = /\/[A-Za-z0-9_.:-]+\s+Do\b/;
const INLINE_IMAGE_RE = /(?:^|\s)BI\s+[\s\S]*?\sID\s+[\s\S]*?\sEI(?:\s|$)/;

function hasTextOperators(content: string): boolean {
  return TEXT_OPERATOR_RE.test(content);
}

function hasImageOperators(content: string): boolean {
  return XOBJECT_DO_RE.test(content) || INLINE_IMAGE_RE.test(content);
}

function isBlankLikeContent(content: string): boolean {
  const trimmed = content.trim();
  if (trimmed.length === 0) return true;
  const withoutGraphicsState = trimmed.replace(/\b[qQ]\b/g, "").trim();
  return withoutGraphicsState.length === 0;
}

function classifyPageContent(contents: Array<string | null>): PageVerificationStatus {
  if (contents.length === 0) return "blank";
  if (contents.some((c) => c !== null && hasTextOperators(c))) return "text";
  const resolved = contents.filter((c): c is string => c !== null);
  if (resolved.length === 0) return "unresolved";
  if (resolved.every((c) => isBlankLikeContent(c))) {
    return contents.length === resolved.length ? "blank" : "unresolved";
  }
  return resolved.some((c) => hasImageOperators(c)) ? "image_without_text" : "image_without_text";
}

export function verifyPerPageText(buffer: Buffer): OcrVerificationResult {
  const text = buffer.toString("latin1");

  if (buffer.length === 0 || !text.startsWith("%PDF-")) {
    return { totalPages: 0, ocrTargetPages: 0, verifiedPages: 0, pageStatuses: [] };
  }

  const totalPages = extractPageCount(buffer);
  const pageRefs = collectPageContentRefs(text, buffer, totalPages);
  let verifiedPages = 0;
  const pageStatuses: PageVerificationStatus[] = [];

  for (const refs of pageRefs) {
    const resolvedContents = refs.map(([objNum, genNum]) => resolveStreamText(text, buffer, objNum, genNum));
    const status = classifyPageContent(resolvedContents);
    pageStatuses.push(status);
    if (status === "text" || status === "blank") {
      verifiedPages++;
    }
  }

  // Pad missing page statuses as "unresolved" so downstream retry/rescue
  // logic includes pages whose content refs could not be collected.
  while (pageStatuses.length < totalPages) {
    pageStatuses.push("unresolved");
  }

  return { totalPages, ocrTargetPages: totalPages, verifiedPages, pageStatuses };
}

function collectPageContentRefsFromText(text: string): [number, number][][] {
  const result: [number, number][][] = [];
  const pageRegex = /\/Type\s*\/Page\b(?!s)/g;
  let match;

  while ((match = pageRegex.exec(text)) !== null) {
    const endobjIdx = text.indexOf("endobj", match.index);
    const windowEnd = endobjIdx !== -1
      ? endobjIdx
      : Math.min(text.length, match.index + 2000);

    const searchStart = Math.max(0, match.index - 10000);
    const searchRegion = text.substring(searchStart, match.index);
    const objMatches = [...searchRegion.matchAll(/\b(\d+)\s+\d+\s+obj\b/g)];
    const lastObjMatch = objMatches.length > 0 ? objMatches[objMatches.length - 1] : null;
    const regionStart = lastObjMatch && lastObjMatch.index !== undefined
      ? searchStart + lastObjMatch.index
      : match.index;
    const region = text.substring(regionStart, windowEnd);

    const arrayMatch = region.match(/\/Contents\s*\[\s*([^\]]+)\]/);
    if (arrayMatch && arrayMatch[1]) {
      const refs: [number, number][] = [];
      const refRegex = /(\d+)\s+(\d+)\s+R/g;
      let refMatch;
      while ((refMatch = refRegex.exec(arrayMatch[1])) !== null) {
        refs.push([parseInt(refMatch[1]!, 10), parseInt(refMatch[2]!, 10)]);
      }
      if (refs.length > 0) result.push(refs);
      continue;
    }

    const singleMatch = region.match(/\/Contents\s+(\d+)\s+(\d+)\s+R/);
    if (singleMatch && singleMatch[1]) {
      result.push([[parseInt(singleMatch[1]!, 10), parseInt(singleMatch[2]!, 10)]]);
      continue;
    }

    result.push([]);
  }

  return result;
}

function collectPageContentRefs(text: string, buffer: Buffer, expectedPageCount: number): [number, number][][] {
  const fromRawText = collectPageContentRefsFromText(text);
  if (fromRawText.length === expectedPageCount) return fromRawText;

  let totalDecompressed = 0;
  const accumulated: [number, number][][] = [];
  for (const streamText of flateStreamIterator(text, buffer)) {
    totalDecompressed += streamText.length;
    if (totalDecompressed > MAX_TOTAL_BUDGET) break;
    const fromStream = collectPageContentRefsFromText(streamText);
    if (fromStream.length === expectedPageCount) return fromStream;
    accumulated.push(...fromStream);
  }

  return accumulated.length > fromRawText.length ? accumulated : fromRawText;
}

function resolveStreamText(
  text: string,
  buffer: Buffer,
  objNum: number,
  genNum?: number,
): string | null {
  const genPattern = genNum !== undefined ? genNum : `\\d+`;
  const objPattern = new RegExp(`\\b${objNum}\\s+${genPattern}\\s+obj\\b`);
  const objMatch = objPattern.exec(text);
  if (!objMatch) return null;

  const objStart = objMatch.index;
  const endobjIdx = text.indexOf("endobj", objStart);
  if (endobjIdx === -1) return null;

  const objBody = text.substring(objStart, endobjIdx);

  const streamMarkerMatch = objBody.match(/stream\r?\n/);
  if (!streamMarkerMatch || streamMarkerMatch.index === undefined) {
    const indirectArrayMatch = objBody.match(/\[\s*((?:\d+\s+\d+\s+R\s*)+)\]/);
    if (indirectArrayMatch) {
      const refRegex = /(\d+)\s+(\d+)\s+R/g;
      let refMatch;
      const parts: string[] = [];
      while ((refMatch = refRegex.exec(indirectArrayMatch[1]!)) !== null) {
        const refNum = parseInt(refMatch[1]!, 10);
        const refGen = parseInt(refMatch[2]!, 10);
        if (refNum === objNum) continue;
        const resolved = resolveStreamText(text, buffer, refNum, refGen);
        if (resolved !== null) parts.push(resolved);
      }
      return parts.length > 0 ? parts.join("\n") : null;
    }
    return null;
  }

  const dataStart = objStart + streamMarkerMatch.index + streamMarkerMatch[0].length;
  const endstreamIdx = text.indexOf("endstream", dataStart);
  if (endstreamIdx === -1 || endstreamIdx >= endobjIdx) return null;

  let dataEnd = endstreamIdx;
  while (
    dataEnd > dataStart &&
    (text[dataEnd - 1] === "\n" || text[dataEnd - 1] === "\r")
  ) {
    dataEnd--;
  }

  if (/\/Filter\s*(\/FlateDecode|\[\s*\/FlateDecode)/.test(objBody)) {
    try {
      const compressed = buffer.subarray(dataStart, dataEnd);
      const decompressed = inflateSync(compressed, {
        maxOutputLength: MAX_DECOMPRESSED_STREAM_SIZE,
      });
      return decompressed.toString("latin1");
    } catch {
      return null;
    }
  }

  return text.substring(dataStart, dataEnd);
}
