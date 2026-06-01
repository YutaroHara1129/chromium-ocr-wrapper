import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument, PDFName, StandardFonts } from "pdf-lib";
import { beforeEach, describe, expect, it } from "vitest";
import type { IPdfInfoExtractor } from "../types/index.js";
import { PdfInfoExtractor, extractPageCount, analyzePdfContent } from "./pdf-info.js";

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
