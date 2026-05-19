import { readFile } from "node:fs/promises";
import { PDFDocument } from "pdf-lib";
import type { IPdfInfoExtractor, PdfMetadata } from "../types/index.js";

export class PdfInfoExtractor implements IPdfInfoExtractor {
  async getMetadataFromFile(filePath: string): Promise<PdfMetadata> {
    const pdfBytes = await readFile(filePath);
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
}
