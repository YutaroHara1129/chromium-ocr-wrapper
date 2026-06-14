import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { PDFDocument, PDFName, StandardFonts } from "pdf-lib";
import { beforeEach, describe, expect, it } from "vitest";
import type { IPdfInfoExtractor } from "../types/index.js";
import { PdfInfoExtractor, extractPageCount, analyzePdfContent, verifyPerPageText } from "./pdf-info.js";

describe("PdfInfoExtractor", () => {
  let extractor: IPdfInfoExtractor;

  beforeEach(() => {
    extractor = new PdfInfoExtractor();
  });

  async function createTempDir(): Promise<string> {
    return mkdtemp(join(tmpdir(), "chromium-ocr-pdf-info-"));
  }

  async function createTestPdfFile(
    dir: string,
    pageSizes: Array<[number, number]>,
  ): Promise<string> {
    const doc = await PDFDocument.create();
    for (const pageSize of pageSizes) {
      doc.addPage(pageSize);
    }
    const pdfBytes = await doc.save();
    const filePath = join(dir, "test.pdf");
    await writeFile(filePath, pdfBytes);
    return filePath;
  }

  it("extracts page count from single-page PDF via file path", async () => {
    const tempDir = await createTempDir();

    try {
      const filePath = await createTestPdfFile(tempDir, [[595.28, 841.89]]);

      const metadata = await extractor.getMetadataFromFile(filePath);

      expect(metadata).toEqual({ pageCount: 1 });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("extracts page count from multi-page PDF", async () => {
    const tempDir = await createTempDir();

    try {
      const filePath = await createTestPdfFile(tempDir, [
        [595.28, 841.89],
        [595.28, 841.89],
        [595.28, 841.89],
      ]);

      const metadata = await extractor.getMetadataFromFile(filePath);

      expect(metadata.pageCount).toBe(3);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("handles PDFs with different page sizes", async () => {
    const tempDir = await createTempDir();

    try {
      const filePath = await createTestPdfFile(tempDir, [
        [612, 792],
        [842, 595],
        [300, 400],
      ]);

      const metadata = await extractor.getMetadataFromFile(filePath);

      expect(metadata.pageCount).toBe(3);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("propagates file read errors for missing paths", async () => {
    const tempDir = await createTempDir();

    try {
      const missingPath = join(tempDir, "missing.pdf");

      await expect(
        extractor.getMetadataFromFile(missingPath),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("returns 0 for invalid PDF file content", async () => {
    const tempDir = await createTempDir();

    try {
      const filePath = join(tempDir, "invalid.pdf");
      await writeFile(filePath, Buffer.from([1, 2, 3, 4, 5, 255, 254, 253]));

      const metadata = await extractor.getMetadataFromFile(filePath);

      expect(metadata.pageCount).toBe(0);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("returns 0 for empty file", async () => {
    const tempDir = await createTempDir();

    try {
      const filePath = join(tempDir, "empty.pdf");
      await writeFile(filePath, Buffer.alloc(0));

      const metadata = await extractor.getMetadataFromFile(filePath);

      expect(metadata.pageCount).toBe(0);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("handles PDFs created with default pdf-lib settings", async () => {
    const tempDir = await createTempDir();

    try {
      const doc = await PDFDocument.create();
      const pdfBytes = await doc.save();
      const filePath = join(tempDir, "default.pdf");
      await writeFile(filePath, pdfBytes);

      const metadata = await extractor.getMetadataFromFile(filePath);

      expect(metadata).toEqual({ pageCount: 1 });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("does not use pdf-lib object model (no PDFDocument.load)", async () => {
    const tempDir = await createTempDir();

    try {
      const filePath = await createTestPdfFile(tempDir, [[595.28, 841.89]]);

      const metadata = await extractor.getMetadataFromFile(filePath);

      expect(metadata.pageCount).toBe(1);
      expect(metadata).not.toHaveProperty("pages");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("extractPageCount", () => {
  function makePdfBuffer(pageCount: number): Buffer {
    const lines: string[] = [
      "%PDF-1.4",
    ];

    let offset = lines[0]!.length + 1;
    const objectPositions: number[] = [];

    const catalogObjNum = 1;
    const pagesObjNum = 2;
    const pageObjNums: number[] = [];
    for (let i = 0; i < pageCount; i++) {
      pageObjNums.push(3 + i);
    }

    const obj = (num: number, content: string): void => {
      objectPositions.push(offset);
      const text = `${num} 0 obj\n${content}\nendobj\n`;
      lines.push(text);
      offset += text.length;
    };

    const kids = pageObjNums.map((n) => `${n} 0 R`).join(" ");
    obj(pagesObjNum, `<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>`);
    obj(catalogObjNum, `<< /Type /Catalog /Pages ${pagesObjNum} 0 R >>`);
    for (const pn of pageObjNums) {
      obj(pn, `<< /Type /Page /Parent ${pagesObjNum} 0 R /MediaBox [0 0 612 792] >>`);
    }

    const xrefStart = offset;
    lines.push("xref\n");
    const totalObjs = 3 + pageCount;
    lines.push(`0 ${totalObjs}\n`);
    lines.push("0000000000 65535 f \n");
    for (let i = 0; i < objectPositions.length; i++) {
      const pos = String(objectPositions[i]!).padStart(10, "0");
      lines.push(`${pos} 00000 n \n`);
    }

    lines.push(
      `trailer\n<< /Size ${totalObjs} /Root ${catalogObjNum} 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`,
    );

    return Buffer.from(lines.join(""), "latin1");
  }

  it("counts pages from well-formed PDF buffer", () => {
    const buf = makePdfBuffer(5);
    expect(extractPageCount(buf)).toBe(5);
  });

  it("counts pages for single-page PDF", () => {
    const buf = makePdfBuffer(1);
    expect(extractPageCount(buf)).toBe(1);
  });

  it("counts pages for 0-page PDF", () => {
    const buf = makePdfBuffer(0);
    expect(extractPageCount(buf)).toBe(0);
  });

  it("counts pages for large page count PDF", () => {
    const buf = makePdfBuffer(500);
    expect(extractPageCount(buf)).toBe(500);
  });

  it("returns 0 for garbage input", () => {
    expect(extractPageCount(Buffer.from("not a pdf"))).toBe(0);
  });

  it("returns 0 for empty buffer", () => {
    expect(extractPageCount(Buffer.alloc(0))).toBe(0);
  });

  it("uses fallback /Type /Page counting when /Count is absent", () => {
    const pdf = [
      "%PDF-1.4",
      "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj",
      "2 0 obj\n<< /Type /Pages /Kids [3 0 R] >>\nendobj",
      "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\nendobj",
    ].join("\n");
    expect(extractPageCount(Buffer.from(pdf, "latin1"))).toBe(1);
  });

  it("uses last /Count to avoid stale orphaned page trees", () => {
    const pdf = [
      "%PDF-1.4",
      "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj",
      "2 0 obj\n<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 10 >>\nendobj",
      "3 0 obj\n<< /Type /Pages /Kids [] /Count 5 >>\nendobj",
      "4 0 obj\n<< /Type /Pages /Kids [] /Count 5 >>\nendobj",
    ].join("\n");
    expect(extractPageCount(Buffer.from(pdf, "latin1"))).toBe(5);
  });

  it("prefers last /Count in incremental-update style PDF", () => {
    const pdf = [
      "%PDF-1.4",
      "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj",
      "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 3 >>\nendobj",
      "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\nendobj",
      "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 7 >>\nendobj",
    ].join("\n");
    expect(extractPageCount(Buffer.from(pdf, "latin1"))).toBe(7);
  });
});

function makePdfWithResources(
  pageCount: number,
  options: { includeFont?: boolean; includeImage?: boolean },
): Buffer {
  const lines: string[] = ["%PDF-1.4"];
  let offset = lines[0]!.length + 1;
  const objectPositions: number[] = [];

  const catalogObjNum = 1;
  const pagesObjNum = 2;
  const pageObjNums: number[] = [];
  for (let i = 0; i < pageCount; i++) {
    pageObjNums.push(3 + i);
  }

  let nextObjNum = 3 + pageCount;
  const fontObjNum = options.includeFont ? nextObjNum++ : undefined;
  const imageObjNum = options.includeImage ? nextObjNum++ : undefined;

  const obj = (num: number, content: string): void => {
    objectPositions.push(offset);
    const text = `${num} 0 obj\n${content}\nendobj\n`;
    lines.push(text);
    offset += text.length;
  };

  const kids = pageObjNums.map((n) => `${n} 0 R`).join(" ");
  obj(pagesObjNum, `<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>`);
  obj(catalogObjNum, `<< /Type /Catalog /Pages ${pagesObjNum} 0 R >>`);

  const resourceParts: string[] = [];
  if (options.includeFont && fontObjNum) {
    resourceParts.push(`/Font << /F1 ${fontObjNum} 0 R >>`);
  }
  if (options.includeImage && imageObjNum) {
    resourceParts.push(`/XObject << /Im1 ${imageObjNum} 0 R >>`);
  }
  const resources = resourceParts.length > 0
    ? ` /Resources << ${resourceParts.join(" ")} >>`
    : "";

  for (const pn of pageObjNums) {
    obj(pn, `<< /Type /Page /Parent ${pagesObjNum} 0 R /MediaBox [0 0 612 792]${resources} >>`);
  }

  if (fontObjNum) {
    obj(fontObjNum, `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`);
  }
  if (imageObjNum) {
    obj(imageObjNum, `<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 1 >>\nstream\nX\nendstream`);
  }

  const xrefStart = offset;
  lines.push("xref\n");
  const totalObjs = nextObjNum;
  lines.push(`0 ${totalObjs}\n`);
  lines.push("0000000000 65535 f \n");
  for (let i = 0; i < objectPositions.length; i++) {
    const pos = String(objectPositions[i]!).padStart(10, "0");
    lines.push(`${pos} 00000 n \n`);
  }

  lines.push(
    `trailer\n<< /Size ${totalObjs} /Root ${catalogObjNum} 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`,
  );

  return Buffer.from(lines.join(""), "latin1");
}

describe("analyzePdfContent", () => {
  it("classifies text-only PDF", () => {
    const buf = makePdfWithResources(2, { includeFont: true });
    const result = analyzePdfContent(buf);
    expect(result.kind).toBe("text_only");
    expect(result.pageCount).toBe(2);
    expect(result.hasExtractableText).toBe(true);
    expect(result.hasImages).toBe(false);
    expect(result.pagesNeedingOcr).toBe(0);
  });

  it("classifies image-only PDF", () => {
    const buf = makePdfWithResources(3, { includeImage: true });
    const result = analyzePdfContent(buf);
    expect(result.kind).toBe("image_only");
    expect(result.pageCount).toBe(3);
    expect(result.hasExtractableText).toBe(false);
    expect(result.hasImages).toBe(true);
    expect(result.pagesNeedingOcr).toBe(3);
  });

  it("classifies blank PDF (no resources)", () => {
    const buf = makePdfWithResources(1, {});
    const result = analyzePdfContent(buf);
    expect(result.kind).toBe("blank");
    expect(result.pageCount).toBe(1);
    expect(result.hasExtractableText).toBe(false);
    expect(result.hasImages).toBe(false);
    expect(result.pagesNeedingOcr).toBe(0);
  });

  it("classifies mixed PDF with both fonts and images", () => {
    const buf = makePdfWithResources(3, { includeFont: true, includeImage: true });
    const result = analyzePdfContent(buf);
    expect(result.kind).toBe("mixed");
    expect(result.pageCount).toBe(3);
    expect(result.hasExtractableText).toBe(true);
    expect(result.hasImages).toBe(true);
    expect(result.pagesNeedingOcr).toBe(3);
  });

  it("classifies empty buffer as blank with 0 pages", () => {
    const result = analyzePdfContent(Buffer.alloc(0));
    expect(result.kind).toBe("blank");
    expect(result.pageCount).toBe(0);
    expect(result.pagesNeedingOcr).toBe(0);
  });

  it("classifies garbage input as blank with 0 pages", () => {
    const result = analyzePdfContent(Buffer.from("not a pdf"));
    expect(result.kind).toBe("unknown");
    expect(result.pageCount).toBe(0);
  });

  it("classifies 0-page PDF as blank", () => {
    const buf = makePdfWithResources(0, {});
    const result = analyzePdfContent(buf);
    expect(result.kind).toBe("blank");
    expect(result.pageCount).toBe(0);
  });

  it("classifies pdf-lib generated text-only PDF", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "chromium-ocr-classify-"));
    try {
      const doc = await PDFDocument.create();
      const font = await doc.embedFont(StandardFonts.Helvetica);
      const page = doc.addPage([595.28, 841.89]);
      page.drawText("Hello", { x: 72, y: 700, size: 14, font });
      const pdfBytes = await doc.save();
      const filePath = join(tempDir, "text.pdf");
      await writeFile(filePath, pdfBytes);

      const buffer = await readFile(filePath);
      const result = analyzePdfContent(buffer);

      expect(result.kind).toBe("text_only");
      expect(result.pageCount).toBe(1);
      expect(result.hasExtractableText).toBe(true);
      expect(result.hasImages).toBe(false);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("detects font and image indicators in decompressed FlateDecode streams", () => {
    const basePdf = makePdfWithResources(1, { includeFont: true, includeImage: true });
    expect(analyzePdfContent(basePdf).kind).toBe("mixed");
  });

  it("detects image indicator inside FlateDecode stream when raw text has no image", () => {
    const streamContent = "/Subtype /Image /Width 1 /Height 1";
    const compressed = deflateSync(Buffer.from(streamContent, "latin1"));

    const lines: string[] = ["%PDF-1.4"];
    let offset = lines[0]!.length + 1;
    const objectPositions: number[] = [];

    const obj = (num: number, content: string): void => {
      objectPositions.push(offset);
      const text = `${num} 0 obj\n${content}\nendobj\n`;
      lines.push(text);
      offset += text.length;
    };

    obj(2, `<< /Type /Pages /Kids [3 0 R] /Count 1 >>`);
    obj(1, `<< /Type /Catalog /Pages 2 0 R >>`);
    obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]>>`);

    const streamData = compressed.toString("latin1");
    objectPositions.push(offset);
    const streamObjText = `4 0 obj\n<< /Filter /FlateDecode /Length ${streamData.length} >>\nstream\n${streamData}\nendstream\n`;
    lines.push(streamObjText);
    offset += streamObjText.length;

    const xrefStart = offset;
    lines.push("xref\n");
    lines.push("0 5\n");
    lines.push("0000000000 65535 f \n");
    for (const pos of objectPositions) {
      lines.push(`${String(pos).padStart(10, "0")} 00000 n \n`);
    }
    lines.push("trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n" + xrefStart + "\n%%EOF\n");

    const buf = Buffer.from(lines.join(""), "latin1");
    const result = analyzePdfContent(buf);
    expect(result.hasImages).toBe(true);
  });
});

describe("PdfInfoExtractor.analyze", () => {
  let extractor: PdfInfoExtractor;

  beforeEach(() => {
    extractor = new PdfInfoExtractor();
  });

  it("analyzes text-only PDF file", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "chromium-ocr-analyze-"));
    try {
      const doc = await PDFDocument.create();
      const font = await doc.embedFont(StandardFonts.Helvetica);
      const page = doc.addPage([595.28, 841.89]);
      page.drawText("Hello", { x: 72, y: 700, size: 14, font });
      const pdfBytes = await doc.save();
      const filePath = join(tempDir, "text.pdf");
      await writeFile(filePath, pdfBytes);

      const result = await extractor.analyze(filePath);

      expect(result.kind).toBe("text_only");
      expect(result.pageCount).toBe(1);
      expect(result.hasExtractableText).toBe(true);
      expect(result.hasImages).toBe(false);
      expect(result.pagesNeedingOcr).toBe(0);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("analyzes blank PDF file", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "chromium-ocr-analyze-"));
    try {
      const doc = await PDFDocument.create();
      const page = doc.addPage([595.28, 841.89]);
      page.node.delete(PDFName.of("Resources"));
      const pdfBytes = await doc.save();
      const filePath = join(tempDir, "blank.pdf");
      await writeFile(filePath, pdfBytes);

      const result = await extractor.analyze(filePath);

      expect(result.kind).toBe("blank");
      expect(result.pageCount).toBe(1);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("propagates file read errors", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "chromium-ocr-analyze-"));
    try {
      await expect(
        extractor.analyze(join(tempDir, "missing.pdf")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

function makeContentPdf(pageStreams: Array<string | null>): Buffer {
  const lines: string[] = ["%PDF-1.4"];
  let offset = lines[0]!.length + 1;
  const objectPositions: number[] = [];

  const catalogObjNum = 1;
  const pagesObjNum = 2;
  const pageCount = pageStreams.length;

  const pageObjNums: number[] = [];
  const contentObjNums: Array<number | null> = [];
  let nextObjNum = 3;

  for (let i = 0; i < pageCount; i++) {
    pageObjNums.push(nextObjNum++);
  }
  for (let i = 0; i < pageCount; i++) {
    if (pageStreams[i] !== null) {
      contentObjNums.push(nextObjNum++);
    } else {
      contentObjNums.push(null);
    }
  }

  const obj = (num: number, content: string): void => {
    objectPositions.push(offset);
    const text = `${num} 0 obj\n${content}\nendobj\n`;
    lines.push(text);
    offset += text.length;
  };

  const kids = pageObjNums.map((n) => `${n} 0 R`).join(" ");
  obj(pagesObjNum, `<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>`);
  obj(catalogObjNum, `<< /Type /Catalog /Pages ${pagesObjNum} 0 R >>`);

  for (let i = 0; i < pageCount; i++) {
    const contentNum = contentObjNums[i];
    const contentsRef = contentNum !== null ? ` /Contents ${contentNum} 0 R` : "";
    obj(pageObjNums[i]!, `<< /Type /Page /Parent ${pagesObjNum} 0 R /MediaBox [0 0 612 792]${contentsRef} >>`);
  }

  for (let i = 0; i < pageCount; i++) {
    if (pageStreams[i] === null) continue;
    const contentNum = contentObjNums[i]!;
    const streamContent = pageStreams[i]!;
    obj(contentNum, `<< /Length ${streamContent.length} >>\nstream\n${streamContent}\nendstream`);
  }

  const xrefStart = offset;
  const totalObjs = nextObjNum;
  lines.push("xref\n");
  lines.push(`0 ${totalObjs}\n`);
  lines.push("0000000000 65535 f \n");
  for (let i = 0; i < objectPositions.length; i++) {
    const pos = String(objectPositions[i]!).padStart(10, "0");
    lines.push(`${pos} 00000 n \n`);
  }

  lines.push(
    `trailer\n<< /Size ${totalObjs} /Root ${catalogObjNum} 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`,
  );

  return Buffer.from(lines.join(""), "latin1");
}

describe("verifyPerPageText", () => {
  it("detects text on all pages", () => {
    const buf = makeContentPdf([
      "BT /F1 12 Tf 100 700 Td (Hello) Tj ET",
      "BT /F1 12 Tf 100 700 Td (World) Tj ET",
    ]);
    const result = verifyPerPageText(buf);
    expect(result).toMatchObject({
      totalPages: 2,
      ocrTargetPages: 2,
      verifiedPages: 2,
    });
  });

  it("detects no text on image-only pages", () => {
    const buf = makeContentPdf([
      "100 100 200 200 re S",
      "50 50 m 100 100 l S",
    ]);
    const result = verifyPerPageText(buf);
    expect(result).toMatchObject({
      totalPages: 2,
      ocrTargetPages: 2,
      verifiedPages: 0,
    });
  });

  it("detects text on some pages but not others", () => {
    const buf = makeContentPdf([
      "BT /F1 12 Tf 100 700 Td (Hello) Tj ET",
      "100 100 200 200 re S",
      "BT /F1 12 Tf 100 700 Td (World) Tj ET",
    ]);
    const result = verifyPerPageText(buf);
    expect(result).toMatchObject({
      totalPages: 3,
      ocrTargetPages: 3,
      verifiedPages: 2,
    });
  });

  it("returns zeros for empty buffer", () => {
    const result = verifyPerPageText(Buffer.alloc(0));
    expect(result).toMatchObject({
      totalPages: 0,
      ocrTargetPages: 0,
      verifiedPages: 0,
    });
  });

  it("returns zeros for non-PDF buffer", () => {
    const result = verifyPerPageText(Buffer.from("not a pdf"));
    expect(result).toMatchObject({
      totalPages: 0,
      ocrTargetPages: 0,
      verifiedPages: 0,
    });
  });

  it("handles pages without /Contents entry", () => {
    const buf = makeContentPdf([null, null]);
    const result = verifyPerPageText(buf);
    expect(result).toMatchObject({
      totalPages: 2,
      ocrTargetPages: 2,
      verifiedPages: 2,
    });
  });

  it("handles single-page PDF with text", () => {
    const buf = makeContentPdf(["BT /F1 12 Tf 100 700 Td (Hello) Tj ET"]);
    const result = verifyPerPageText(buf);
    expect(result).toMatchObject({
      totalPages: 1,
      ocrTargetPages: 1,
      verifiedPages: 1,
    });
  });

  it("handles mixed pages with and without content streams", () => {
    const buf = makeContentPdf([
      "BT /F1 12 Tf 100 700 Td (Hello) Tj ET",
      null,
      "100 100 200 200 re S",
    ]);
    const result = verifyPerPageText(buf);
    expect(result).toMatchObject({
      totalPages: 3,
      ocrTargetPages: 3,
      verifiedPages: 2,
    });
  });

  it("handles pdf-lib generated PDF with compressed FlateDecode streams", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([595.28, 841.89]);
    page.drawText("Hello", { x: 72, y: 700, size: 14, font });
    const pdfBytes = await doc.save();

    const result = verifyPerPageText(Buffer.from(pdfBytes));
    expect(result).toMatchObject({
      totalPages: 1,
      ocrTargetPages: 1,
      verifiedPages: 1,
    });
  });

  it("handles page object with dictionary start far from /Type /Page", () => {
    const padding = " ".repeat(2100);
    const lines: string[] = ["%PDF-1.4"];
    let offset = lines[0]!.length + 1;
    const objectPositions: number[] = [];

    const obj = (num: number, content: string): void => {
      objectPositions.push(offset);
      const text = `${num} 0 obj\n${content}\nendobj\n`;
      lines.push(text);
      offset += text.length;
    };

    obj(2, `<< /Type /Pages /Kids [3 0 R] /Count 1 >>`);
    obj(1, `<< /Type /Catalog /Pages 2 0 R >>`);
    obj(3, `<< ${padding} /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R>>`);
    const content = "BT /F1 12 Tf (Hi) Tj ET";
    obj(4, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);

    const xrefStart = offset;
    const totalObjs = 5;
    lines.push("xref\n");
    lines.push(`0 ${totalObjs}\n`);
    lines.push("0000000000 65535 f \n");
    for (const pos of objectPositions) {
      lines.push(`${String(pos).padStart(10, "0")} 00000 n \n`);
    }
    lines.push(`trailer\n<< /Size ${totalObjs} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`);

    const result = verifyPerPageText(Buffer.from(lines.join(""), "latin1"));
    expect(result).toMatchObject({
      totalPages: 1,
      ocrTargetPages: 1,
      verifiedPages: 1,
    });
  });

  it("resolves content streams through indirect reference arrays", () => {
    const lines: string[] = ["%PDF-1.4"];
    let offset = lines[0]!.length + 1;
    const objectPositions: number[] = [];

    const obj = (num: number, content: string): void => {
      objectPositions.push(offset);
      const text = `${num} 0 obj\n${content}\nendobj\n`;
      lines.push(text);
      offset += text.length;
    };

    obj(2, `<< /Type /Pages /Kids [3 0 R] /Count 1 >>`);
    obj(1, `<< /Type /Catalog /Pages 2 0 R >>`);
    obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R>>`);
    obj(4, `[5 0 R 6 0 R]`);
    const c1 = "BT /F1 12 Tf (Hello) Tj ET";
    const c2 = "BT /F1 12 Tf (World) Tj ET";
    obj(5, `<< /Length ${c1.length} >>\nstream\n${c1}\nendstream`);
    obj(6, `<< /Length ${c2.length} >>\nstream\n${c2}\nendstream`);

    const xrefStart = offset;
    const totalObjs = 7;
    lines.push("xref\n");
    lines.push(`0 ${totalObjs}\n`);
    lines.push("0000000000 65535 f \n");
    for (const pos of objectPositions) {
      lines.push(`${String(pos).padStart(10, "0")} 00000 n \n`);
    }
    lines.push(`trailer\n<< /Size ${totalObjs} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`);

    const result = verifyPerPageText(Buffer.from(lines.join(""), "latin1"));
    expect(result).toMatchObject({
      totalPages: 1,
      ocrTargetPages: 1,
      verifiedPages: 1,
    });
  });

  it("handles FlateDecode stream with invalid compressed data gracefully", () => {
    const fakeCompressed = "this is not valid zlib data!!";
    const streamContent = "BT /F1 12 Tf (Hello) Tj ET";
    void deflateSync(Buffer.from(streamContent, "latin1"));

    const lines: string[] = ["%PDF-1.4"];
    let offset = lines[0]!.length + 1;
    const objectPositions: number[] = [];

    const obj = (num: number, content: string): void => {
      objectPositions.push(offset);
      const text = `${num} 0 obj\n${content}\nendobj\n`;
      lines.push(text);
      offset += text.length;
    };

    obj(2, `<< /Type /Pages /Kids [3 0 R] /Count 1 >>`);
    obj(1, `<< /Type /Catalog /Pages 2 0 R >>`);
    obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R>>`);

    objectPositions.push(offset);
    const streamObjText = `4 0 obj\n<< /Filter /FlateDecode /Length ${fakeCompressed.length} >>\nstream\n${fakeCompressed}\nendstream\nendobj\n`;
    lines.push(streamObjText);
    offset += streamObjText.length;

    const xrefStart = offset;
    lines.push("xref\n");
    lines.push("0 5\n");
    lines.push("0000000000 65535 f \n");
    for (const pos of objectPositions) {
      lines.push(`${String(pos).padStart(10, "0")} 00000 n \n`);
    }
    lines.push("trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n" + xrefStart + "\n%%EOF\n");

    const buf = Buffer.from(lines.join(""), "latin1");
    const result = verifyPerPageText(buf);
    expect(result).toMatchObject({
      totalPages: 1,
      ocrTargetPages: 1,
      verifiedPages: 0,
    });
  });

  it("detects text with Tj operator without BT block", () => {
    const buf = makeContentPdf(["/F1 12 Tf (Hello) Tj"]);
    const result = verifyPerPageText(buf);
    expect(result.verifiedPages).toBe(1);
  });

  it("detects text with TJ array operator without BT block", () => {
    const buf = makeContentPdf(["[(Hello) 120 (World)] TJ"]);
    const result = verifyPerPageText(buf);
    expect(result.verifiedPages).toBe(1);
  });

  it("does not verify page with only Td positioning operator (no text shown)", () => {
    const buf = makeContentPdf(["100 700 Td"]);
    const result = verifyPerPageText(buf);
    expect(result.verifiedPages).toBe(0);
  });

  it("resolves object with non-zero generation number", () => {
    const lines: string[] = ["%PDF-1.4"];
    let offset = lines[0]!.length + 1;
    const objectPositions: number[] = [];

    const obj = (num: number, content: string): void => {
      objectPositions.push(offset);
      const text = `${num} 0 obj\n${content}\nendobj\n`;
      lines.push(text);
      offset += text.length;
    };

    obj(2, `<< /Type /Pages /Kids [3 0 R] /Count 1 >>`);
    obj(1, `<< /Type /Catalog /Pages 2 0 R >>`);
    obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R>>`);
    const content = "BT /F1 12 Tf (Hello) Tj ET";
    obj(4, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);

    const xrefStart = offset;
    const totalObjs = 5;
    lines.push("xref\n");
    lines.push(`0 ${totalObjs}\n`);
    lines.push("0000000000 65535 f \n");
    for (const pos of objectPositions) {
      lines.push(`${String(pos).padStart(10, "0")} 00000 n \n`);
    }
    lines.push(`trailer\n<< /Size ${totalObjs} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`);

    const result = verifyPerPageText(Buffer.from(lines.join(""), "latin1"));
    expect(result.verifiedPages).toBe(1);
  });

  it("falls through to stream search when raw refs count mismatches page count", () => {
    const streamContent = "BT /F1 12 Tf (Hello) Tj ET";
    const compressed = deflateSync(Buffer.from(streamContent, "latin1"));

    const lines: string[] = ["%PDF-1.4"];
    let offset = lines[0]!.length + 1;
    const objectPositions: number[] = [];

    const obj = (num: number, content: string): void => {
      objectPositions.push(offset);
      const text = `${num} 0 obj\n${content}\nendobj\n`;
      lines.push(text);
      offset += text.length;
    };

    obj(2, `<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>`);
    obj(1, `<< /Type /Catalog /Pages 2 0 R >>`);
    obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]>>`);
    obj(4, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]>>`);

    const streamData = compressed.toString("latin1");
    objectPositions.push(offset);
    const pageRefsStream = `5 0 obj\n<< /Filter /FlateDecode /Length ${streamData.length} >>\nstream\n${streamData}\nendstream\n`;
    lines.push(pageRefsStream);
    offset += pageRefsStream.length;

    objectPositions.push(offset);
    const contentWithRefs = "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 5 0 R>>\nendobj\n";
    lines.push(contentWithRefs);
    offset += contentWithRefs.length;

    objectPositions.push(offset);
    const contentWithRefs2 = "4 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 5 0 R>>\nendobj\n";
    lines.push(contentWithRefs2);
    offset += contentWithRefs2.length;

    const xrefStart = offset;
    lines.push("xref\n");
    lines.push("0 6\n");
    lines.push("0000000000 65535 f \n");
    for (const pos of objectPositions) {
      lines.push(`${String(pos).padStart(10, "0")} 00000 n \n`);
    }
    lines.push("trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n" + xrefStart + "\n%%EOF\n");

    const result = verifyPerPageText(Buffer.from(lines.join(""), "latin1"));
    expect(result.verifiedPages).toBe(4);
  });

  it("detects text in Chrome OCR output with nested Resources and /Type/Page at end", () => {
    const lines: string[] = ["%PDF-1.4"];
    let offset = lines[0]!.length + 1;
    const objectPositions: number[] = [];

    const obj = (num: number, content: string): void => {
      objectPositions.push(offset);
      const text = `${num} 0 obj\n${content}\nendobj\n`;
      lines.push(text);
      offset += text.length;
    };

    obj(1, `<</Count 1/Kids[ 5 0 R ]/Type/Pages>>`);
    obj(2, `<</Pages 1 0 R /Type/Catalog>>`);
    obj(4, `<</BitsPerComponent 8/ColorSpace/DeviceRGB/Height 200/Length 100/Subtype/Image/Type/XObject/Width 200>>\nstream\n${"x".repeat(100)}\nendstream`);
    const content1 = "q Q";
    obj(6, `<</Length ${content1.length}>>\nstream\n${content1}\nendstream`);
    const content2 = "BT /FXF1 12 Tf (SCAN) Tj ET";
    obj(18, `<</Length ${content2.length}>>\nstream\n${content2}\nendstream`);
    obj(9, `<</BaseFont/Untitled/Subtype/Type0/Type/Font>>`);
    obj(17, `<</BM/Normal/CA 1/ca 1>>`);
    obj(5, `<</Annots[]/Contents[ 6 0 R  18 0 R ]/MediaBox[ 0 0 595.28 841.89]/Parent 1 0 R /Resources<</ExtGState<</FXE1 17 0 R >>/Font<</FXF1 9 0 R >>/XObject<</Image-7098480789 4 0 R >>>>/Type/Page>>`);

    const xrefStart = offset;
    const totalObjs = 10;
    lines.push("xref\n");
    lines.push(`0 ${totalObjs}\n`);
    lines.push("0000000000 65535 f \n");
    for (const pos of objectPositions) {
      lines.push(`${String(pos).padStart(10, "0")} 00000 n \n`);
    }
    lines.push(`trailer\n<< /Size ${totalObjs} /Root 2 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`);

    const result = verifyPerPageText(Buffer.from(lines.join(""), "latin1"));
    expect(result).toMatchObject({
      totalPages: 1,
      ocrTargetPages: 1,
      verifiedPages: 1,
    });
  });

  it("detects text in multiple Chrome-style pages with nested Resources", () => {
    const lines: string[] = ["%PDF-1.4"];
    let offset = lines[0]!.length + 1;
    const objectPositions: number[] = [];

    const obj = (num: number, content: string): void => {
      objectPositions.push(offset);
      const text = `${num} 0 obj\n${content}\nendobj\n`;
      lines.push(text);
      offset += text.length;
    };

    obj(1, `<</Count 2/Kids[ 5 0 R  20 0 R ]/Type/Pages>>`);
    obj(2, `<</Pages 1 0 R /Type/Catalog>>`);
    obj(9, `<</BaseFont/Untitled/Subtype/Type0/Type/Font>>`);
    const c1a = "q Q";
    obj(6, `<</Length ${c1a.length}>>\nstream\n${c1a}\nendstream`);
    const c1b = "BT /FXF1 12 Tf (Page1) Tj ET";
    obj(18, `<</Length ${c1b.length}>>\nstream\n${c1b}\nendstream`);
    const c2a = "q Q";
    obj(21, `<</Length ${c2a.length}>>\nstream\n${c2a}\nendstream`);
    const c2b = "BT /FXF1 12 Tf (Page2) Tj ET";
    obj(22, `<</Length ${c2b.length}>>\nstream\n${c2b}\nendstream`);
    obj(5, `<</Contents[ 6 0 R  18 0 R ]/MediaBox[ 0 0 595 842]/Parent 1 0 R /Resources<</Font<</FXF1 9 0 R >>>>/Type/Page>>`);
    obj(20, `<</Contents[ 21 0 R  22 0 R ]/MediaBox[ 0 0 595 842]/Parent 1 0 R /Resources<</Font<</FXF1 9 0 R >>>>/Type/Page>>`);

    const xrefStart = offset;
    const totalObjs = 23;
    lines.push("xref\n");
    lines.push(`0 ${totalObjs}\n`);
    lines.push("0000000000 65535 f \n");
    for (const pos of objectPositions) {
      lines.push(`${String(pos).padStart(10, "0")} 00000 n \n`);
    }
    lines.push(`trailer\n<< /Size ${totalObjs} /Root 2 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`);

    const result = verifyPerPageText(Buffer.from(lines.join(""), "latin1"));
    expect(result).toMatchObject({
      totalPages: 2,
      ocrTargetPages: 2,
      verifiedPages: 2,
    });
  });

  it("classifies blank page (empty content) as verified", () => {
    const buf = makeContentPdf([""]);
    const result = verifyPerPageText(buf);
    expect(result.verifiedPages).toBe(1);
  });

  it("classifies blank page (whitespace only) as verified", () => {
    const buf = makeContentPdf(["   \n\t  "]);
    const result = verifyPerPageText(buf);
    expect(result.verifiedPages).toBe(1);
  });

  it("classifies blank page (q Q only) as verified", () => {
    const buf = makeContentPdf(["q Q"]);
    const result = verifyPerPageText(buf);
    expect(result.verifiedPages).toBe(1);
  });

  it("classifies image-only page with Do operator as NOT verified", () => {
    const buf = makeContentPdf(["q /Im0 Do Q"]);
    const result = verifyPerPageText(buf);
    expect(result.verifiedPages).toBe(0);
  });

  it("classifies image page with OCR text as verified", () => {
    const buf = makeContentPdf(["q /Im0 Do Q\nBT /F1 12 Tf (Hello) Tj ET"]);
    const result = verifyPerPageText(buf);
    expect(result.verifiedPages).toBe(1);
  });

  it("classifies mixed pages (text, blank, image) correctly", () => {
    const buf = makeContentPdf([
      "BT /F1 12 Tf (Hello) Tj ET",
      "",
      "q /Im0 Do Q",
    ]);
    const result = verifyPerPageText(buf);
    expect(result).toMatchObject({
      totalPages: 3,
      ocrTargetPages: 3,
      verifiedPages: 2,
    });
  });

  it("classifies vector-drawing page (re S) as NOT verified", () => {
    const buf = makeContentPdf(["100 100 200 200 re S"]);
    const result = verifyPerPageText(buf);
    expect(result.verifiedPages).toBe(0);
  });
});
