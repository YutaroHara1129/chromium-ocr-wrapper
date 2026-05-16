import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument } from "pdf-lib";
import { beforeEach, describe, expect, it } from "vitest";
import type { IPdfInfoExtractor } from "../types/index.js";
import { PdfInfoExtractor } from "./pdf-info.js";

describe("PdfInfoExtractor", () => {
  let extractor: IPdfInfoExtractor;

  beforeEach(() => {
    extractor = new PdfInfoExtractor();
  });

  async function createTempDir(): Promise<string> {
    return mkdtemp(join(tmpdir(), "chromium-ocr-pdf-info-"));
  }

  async function createTestPdf(pageSizes: Array<[number, number]>): Promise<Uint8Array> {
    const doc = await PDFDocument.create();

    for (const pageSize of pageSizes) {
      doc.addPage(pageSize);
    }

    return doc.save();
  }

  it("extracts metadata from single-page PDF", async () => {
    const pdfBytes = await createTestPdf([[595.28, 841.89]]);

    const metadata = await extractor.getMetadata(pdfBytes);

    expect(metadata).toEqual({
      pageCount: 1,
      pages: [{ width: 595.28, height: 841.89 }],
    });
  });

  it("extracts metadata from multi-page PDF and reports each page", async () => {
    const pdfBytes = await createTestPdf([
      [595.28, 841.89],
      [595.28, 841.89],
      [595.28, 841.89],
    ]);

    const metadata = await extractor.getMetadata(pdfBytes);

    expect(metadata.pageCount).toBe(3);
    expect(metadata.pages).toEqual([
      { width: 595.28, height: 841.89 },
      { width: 595.28, height: 841.89 },
      { width: 595.28, height: 841.89 },
    ]);
  });

  it("handles different page sizes within same PDF", async () => {
    const pdfBytes = await createTestPdf([
      [612, 792],
      [842, 595],
      [300, 400],
    ]);

    const metadata = await extractor.getMetadata(pdfBytes);

    expect(metadata).toEqual({
      pageCount: 3,
      pages: [
        { width: 612, height: 792 },
        { width: 842, height: 595 },
        { width: 300, height: 400 },
      ],
    });
  });

  it("reads PDF bytes from file", async () => {
    const tempDir = await createTempDir();

    try {
      const filePath = join(tempDir, "input.pdf");
      const pdfBytes = await createTestPdf([[595.28, 841.89]]);
      await writeFile(filePath, pdfBytes);

      const readBytes = await extractor.readPdfBytes(filePath);

      expect(readBytes).toBeInstanceOf(Uint8Array);
      expect(readBytes).toEqual(new Uint8Array(await readFile(filePath)));
      expect(readBytes).toEqual(pdfBytes);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects invalid PDF bytes", async () => {
    const invalidBytes = new Uint8Array([1, 2, 3, 4, 5, 255, 254, 253]);

    await expect(extractor.getMetadata(invalidBytes)).rejects.toThrow();
  });

  it("rejects empty PDF bytes", async () => {
    await expect(extractor.getMetadata(new Uint8Array())).rejects.toThrow();
  });

  it("propagates file read errors for missing paths", async () => {
    const tempDir = await createTempDir();

    try {
      const missingPath = join(tempDir, "missing.pdf");

      await expect(extractor.readPdfBytes(missingPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("handles PDFs created with default pdf-lib settings", async () => {
    const doc = await PDFDocument.create();
    const pdfBytes = await doc.save();

    const metadata = await extractor.getMetadata(pdfBytes);

    expect(metadata).toEqual({
      pageCount: 1,
      pages: [{ width: 595.28, height: 841.89 }],
    });
  });
});
