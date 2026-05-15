import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { join } from "node:path";
import { mkdtemp, rm, stat, readFile, writeFile, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { ConversionPipeline } from "../src/core/pipeline.js";
import { ChromeSearchifyPrinter } from "../src/core/chrome-searchify-printer.js";
import { PdfInfoExtractor } from "../src/utils/pdf-info.js";
import { NodeFileWriter } from "../src/utils/file-writer.js";

const CHROME_PATH =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

describe("E2E: Chrome PDFSearchify Pipeline", () => {
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ocr-e2e-"));
  }, 10_000);

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  });

  async function createImagePdf(name: string, text: string): Promise<string> {
    const { createCanvas } = await import("canvas");
    const canvas = createCanvas(595, 842);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, 595, 842);
    ctx.fillStyle = "black";
    ctx.font = "24px sans-serif";
    ctx.fillText(text, 72, 200);

    const pngBuffer = canvas.toBuffer("image/png");
    const doc = await PDFDocument.create();
    const page = doc.addPage([595.28, 841.89]);
    const pngImage = await doc.embedPng(pngBuffer);
    page.drawImage(pngImage, {
      x: 0,
      y: 0,
      width: 595.28,
      height: 841.89,
    });

    const pdfBytes = await doc.save();
    const filePath = join(tempDir, name);
    await writeFile(filePath, pdfBytes);
    return filePath;
  }

  async function createTextPdf(name: string, text: string): Promise<string> {
    const doc = await PDFDocument.create();
    const page = doc.addPage([595.28, 841.89]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    page.drawText(text, { x: 72, y: 720, size: 12, font });
    const pdfBytes = await doc.save();
    const filePath = join(tempDir, name);
    await writeFile(filePath, pdfBytes);
    return filePath;
  }

  it(
    "should convert image-only PDF to searchable PDF with OCR text",
    async () => {
      const inputPath = await createImagePdf(
        "ocr-input.pdf",
        "Hello OCR Test",
      );
      const outputPath = join(tempDir, "ocr-output.pdf");

      const printer = new ChromeSearchifyPrinter();
      const pipeline = new ConversionPipeline(
        printer,
        new PdfInfoExtractor(),
        new NodeFileWriter(),
      );

      try {
        const result = await pipeline.convert({
          inputPath,
          outputPath,
          chromePath: CHROME_PATH,
        });

        expect(result.inputPath).toBe(inputPath);
        expect(result.outputPath).toBe(outputPath);
        expect(result.pageCount).toBe(1);
        expect(result.textSize).toBeGreaterThan(0);

        const outputBytes = await readFile(outputPath);
        const outputDoc = await PDFDocument.load(outputBytes);
        expect(outputDoc.getPageCount()).toBe(1);

        const pdfText = outputBytes.toString("latin1");
        expect(pdfText).toContain("0048");
      } finally {
        await printer.close();
      }
    },
    60_000,
  );

  it(
    "should handle PDF that already has text",
    async () => {
      const inputPath = await createTextPdf("text-input.pdf", "Existing Text");
      const outputPath = join(tempDir, "text-output.pdf");

      const printer = new ChromeSearchifyPrinter();
      const pipeline = new ConversionPipeline(
        printer,
        new PdfInfoExtractor(),
        new NodeFileWriter(),
      );

      try {
        const result = await pipeline.convert({
          inputPath,
          outputPath,
          chromePath: CHROME_PATH,
        });

        expect(result.pageCount).toBe(1);
        expect(result.textSize).toBeGreaterThan(0);
      } finally {
        await printer.close();
      }
    },
    60_000,
  );

  it(
    "should generate default output path with _searchable suffix",
    async () => {
      const inputPath = await createImagePdf(
        "default-path.pdf",
        "Test Default",
      );

      const printer = new ChromeSearchifyPrinter();
      const pipeline = new ConversionPipeline(
        printer,
        new PdfInfoExtractor(),
        new NodeFileWriter(),
      );

      try {
        const result = await pipeline.convert({
          inputPath,
          chromePath: CHROME_PATH,
        });

        expect(result.outputPath).toContain("_searchable.pdf");

        const outputStat = await stat(result.outputPath);
        expect(outputStat.size).toBeGreaterThan(0);
      } finally {
        await printer.close();
      }
    },
    60_000,
  );
});
