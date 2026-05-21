import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument } from "pdf-lib";
import { beforeEach, describe, expect, it } from "vitest";
import type { IPdfInfoExtractor } from "../types/index.js";
import { PdfInfoExtractor, extractPageCount } from "./pdf-info.js";

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
