import { readFile } from "node:fs/promises";
import { PDFDocument } from "pdf-lib";
import type { IPdfInfoExtractor, PdfMetadata } from "../types/index.js";

export class PdfInfoExtractor implements IPdfInfoExtractor {
  async getMetadata(pdfBytes: Uint8Array): Promise<PdfMetadata> {
    const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    const pages = doc.getPages();

    return {
      pageCount: pages.length,
      pages: pages.map((page) => {
        const { width, height } = page.getSize();
        return { width, height };
      }),
    };
  }

  async readPdfBytes(filePath: string): Promise<Uint8Array> {
    const buffer = await readFile(filePath);
    return new Uint8Array(buffer);
  }
}
