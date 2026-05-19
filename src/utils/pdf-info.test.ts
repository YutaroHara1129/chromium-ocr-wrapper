import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

  it("extracts metadata from single-page PDF via file path", async () => {
    const tempDir = await createTempDir();

    try {
      const filePath = await createTestPdfFile(tempDir, [[595.28, 841.89]]);

      const metadata = await extractor.getMetadataFromFile(filePath);

      expect(metadata).toEqual({
        pageCount: 1,
        pages: [{ width: 595.28, height: 841.89 }],
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("extracts metadata from multi-page PDF and reports each page", async () => {
    const tempDir = await createTempDir();

    try {
      const filePath = await createTestPdfFile(tempDir, [
        [595.28, 841.89],
        [595.28, 841.89],
        [595.28, 841.89],
      ]);

      const metadata = await extractor.getMetadataFromFile(filePath);

      expect(metadata.pageCount).toBe(3);
      expect(metadata.pages).toEqual([
        { width: 595.28, height: 841.89 },
        { width: 595.28, height: 841.89 },
        { width: 595.28, height: 841.89 },
      ]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("handles different page sizes within same PDF", async () => {
    const tempDir = await createTempDir();

    try {
      const filePath = await createTestPdfFile(tempDir, [
        [612, 792],
        [842, 595],
        [300, 400],
      ]);

      const metadata = await extractor.getMetadataFromFile(filePath);

      expect(metadata).toEqual({
        pageCount: 3,
        pages: [
          { width: 612, height: 792 },
          { width: 842, height: 595 },
          { width: 300, height: 400 },
        ],
      });
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

  it("rejects invalid PDF file content", async () => {
    const tempDir = await createTempDir();

    try {
      const filePath = join(tempDir, "invalid.pdf");
      await writeFile(filePath, Buffer.from([1, 2, 3, 4, 5, 255, 254, 253]));

      await expect(
        extractor.getMetadataFromFile(filePath),
      ).rejects.toThrow();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects empty file", async () => {
    const tempDir = await createTempDir();

    try {
      const filePath = join(tempDir, "empty.pdf");
      await writeFile(filePath, Buffer.alloc(0));

      await expect(
        extractor.getMetadataFromFile(filePath),
      ).rejects.toThrow();
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

      expect(metadata).toEqual({
        pageCount: 1,
        pages: [{ width: 595.28, height: 841.89 }],
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
