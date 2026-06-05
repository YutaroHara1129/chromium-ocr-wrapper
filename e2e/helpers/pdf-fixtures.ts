import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCanvas } from "canvas";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;

function createScanPng(): Buffer {
  const canvas = createCanvas(200, 200);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#d1d5db";
  ctx.fillRect(0, 0, 200, 200);
  ctx.fillStyle = "#111827";
  ctx.font = "32px sans-serif";
  ctx.fillText("SCAN", 48, 108);
  return canvas.toBuffer("image/png");
}

export async function createTextPdf(
  filePath: string,
  text: string,
): Promise<string> {
  return createMultiPagePdf(filePath, [text]);
}

export async function createMultiPagePdf(
  filePath: string,
  pages: string[],
): Promise<string> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);

  for (const text of pages) {
    const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);

    page.drawText(text, {
      x: 72,
      y: PAGE_HEIGHT - 120,
      size: 14,
      font,
      color: rgb(0, 0, 0),
      maxWidth: PAGE_WIDTH - 144,
      lineHeight: 18,
    });
  }

  const pdfBytes = await doc.save();
  await writeFile(filePath, pdfBytes);

  return filePath;
}

export async function writeInvalidPdf(filePath: string): Promise<string> {
  await writeFile(
    filePath,
    Buffer.from("this is not a valid pdf file", "utf8"),
  );

  return filePath;
}

export async function createImagePdf(
  filePath: string,
  pageCount: number,
): Promise<string> {
  const doc = await PDFDocument.create();
  const image = await doc.embedPng(createScanPng());

  for (let i = 0; i < pageCount; i++) {
    const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    page.drawImage(image, { x: 0, y: 0, width: PAGE_WIDTH, height: PAGE_HEIGHT });
  }

  const pdfBytes = await doc.save();
  await writeFile(filePath, pdfBytes);
  return filePath;
}

export async function createBlankPdf(
  filePath: string,
  pageCount: number,
): Promise<string> {
  const doc = await PDFDocument.create();

  for (let i = 0; i < pageCount; i++) {
    doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  }

  const pdfBytes = await doc.save();
  await writeFile(filePath, pdfBytes);
  return filePath;
}

export async function createMixedPdf(
  filePath: string,
  opts: { textPages: number; imagePages: number; mixedPages: number },
): Promise<string> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const image = await doc.embedPng(createScanPng());

  for (let i = 0; i < opts.textPages; i++) {
    const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    page.drawText(`Text page ${i + 1}`, {
      x: 72, y: PAGE_HEIGHT - 120, size: 14, font, color: rgb(0, 0, 0),
    });
  }

  for (let i = 0; i < opts.imagePages; i++) {
    const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    page.drawImage(image, { x: 0, y: 0, width: PAGE_WIDTH, height: PAGE_HEIGHT });
  }

  for (let i = 0; i < opts.mixedPages; i++) {
    const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    page.drawImage(image, { x: 0, y: 0, width: PAGE_WIDTH, height: PAGE_HEIGHT });
    page.drawText(`Mixed page ${i + 1}`, {
      x: 72, y: PAGE_HEIGHT - 120, size: 14, font, color: rgb(0, 0, 0),
    });
  }

  const pdfBytes = await doc.save();
  await writeFile(filePath, pdfBytes);
  return filePath;
}

export async function createLargePdf(
  filePath: string,
  pageCount: number,
): Promise<string> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);

  for (let i = 0; i < pageCount; i++) {
    const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    page.drawText(`Page ${i + 1}`, {
      x: 72,
      y: PAGE_HEIGHT - 120,
      size: 14,
      font,
      color: rgb(0, 0, 0),
    });
  }

  const pdfBytes = await doc.save();
  await writeFile(filePath, pdfBytes);

  return filePath;
}

export function isObjStmPdf(pdfBytes: Buffer): boolean {
  const text = pdfBytes.toString("latin1");
  return text.includes("/Type /ObjStm");
}

export async function createTempDir(prefix = "chromium-ocr-e2e-"): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function cleanupDir(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}
