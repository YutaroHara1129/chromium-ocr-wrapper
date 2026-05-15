import { describe, it, expect } from "vitest";
import { PdfInfoExtractor } from "./pdf-info.js";
import type { IPdfInfoExtractor } from "../types/index.js";
import { PDFDocument } from "pdf-lib";

describe("PdfInfoExtractor", () => {
  let extractor: IPdfInfoExtractor;

  beforeEach(() => {
    extractor = new PdfInfoExtractor();
  });

  async function createTestPdf(pageCount: number): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    for (let i = 0; i < pageCount; i++) {
      doc.addPage([595.28, 841.89]);
    }
    return doc.save();
  }

  it("should extract metadata from a single page PDF", async () => {
    const pdfBytes = await createTestPdf(1);
    const metadata = await extractor.getMetadata(pdfBytes);

    expect(metadata.pageCount).toBe(1);
    expect(metadata.pages).toHaveLength(1);
    expect(metadata.pages[0]).toEqual({
      width: 595.28,
      height: 841.89,
    });
  });

  it("should extract metadata from a multi-page PDF", async () => {
    const pdfBytes = await createTestPdf(3);
    const metadata = await extractor.getMetadata(pdfBytes);

    expect(metadata.pageCount).toBe(3);
    expect(metadata.pages).toHaveLength(3);
  });

  it("should handle different page sizes within same PDF", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    doc.addPage([842, 595]);
    const pdfBytes = await doc.save();

    const metadata = await extractor.getMetadata(pdfBytes);

    expect(metadata.pageCount).toBe(2);
    expect(metadata.pages[0]).toEqual({ width: 612, height: 792 });
    expect(metadata.pages[1]).toEqual({ width: 842, height: 595 });
  });

  it("should read PDF bytes from file", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const os = await import("node:os");

    const pdfBytes = await createTestPdf(1);
    const tmpPath = path.join(os.tmpdir(), `test-pdf-info-${Date.now()}.pdf`);
    await fs.writeFile(tmpPath, pdfBytes);

    const readBytes = await extractor.readPdfBytes(tmpPath);
    expect(readBytes).toBeInstanceOf(Uint8Array);
    expect(readBytes.length).toBeGreaterThan(0);

    await fs.unlink(tmpPath);
  });
});
