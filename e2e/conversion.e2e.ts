import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PDFDocument } from "pdf-lib";
import { resolve, join } from "node:path";
import { mkdtemp, rm, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { ConversionPipeline } from "../src/core/pipeline.js";
import { ChromePdfPrinter } from "../src/core/chrome-pdf-printer.js";
import { PdfInfoExtractor } from "../src/utils/pdf-info.js";
import { NodeFileWriter } from "../src/utils/file-writer.js";

const CHROME_PATH =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

describe("E2E: ConversionPipeline", () => {
  let tempDir: string;
  let pipeline: ConversionPipeline;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ocr-e2e-"));
    pipeline = new ConversionPipeline(
      new ChromePdfPrinter(),
      new PdfInfoExtractor(),
      new NodeFileWriter(),
    );
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  async function createTestPdf(
    name: string,
    text?: string,
  ): Promise<string> {
    const doc = await PDFDocument.create();
    const page = doc.addPage([595.28, 841.89]);

    if (text) {
      const font = await doc.embedFont(
        (await import("pdf-lib")).StandardFonts.Helvetica,
      );
      page.drawText(text, { x: 72, y: 720, size: 12, font });
    }

    const pdfBytes = await doc.save();
    const filePath = join(tempDir, name);
    await writeFile(filePath, pdfBytes);
    return filePath;
  }

  async function writeFile(path: string, data: Uint8Array): Promise<void> {
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(path, data);
  }

  it("should convert a text PDF and produce a valid output PDF", async () => {
    const inputPath = await createTestPdf("text-input.pdf", "Hello OCR Test");
    const outputPath = join(tempDir, "text-output.pdf");

    const result = await pipeline.convert({
      inputPath,
      outputPath,
      chromePath: CHROME_PATH,
    });

    expect(result.inputPath).toBe(inputPath);
    expect(result.outputPath).toBe(outputPath);
    expect(result.pageCount).toBe(1);

    const outputStat = await stat(outputPath);
    expect(outputStat.size).toBeGreaterThan(0);

    const outputBytes = await readFile(outputPath);
    const outputDoc = await PDFDocument.load(outputBytes);
    expect(outputDoc.getPageCount()).toBe(1);
  });

  it("should convert a PDF without text and produce a valid output PDF", async () => {
    const inputPath = await createTestPdf("empty-input.pdf");
    const outputPath = join(tempDir, "empty-output.pdf");

    const result = await pipeline.convert({
      inputPath,
      outputPath,
      chromePath: CHROME_PATH,
    });

    expect(result.pageCount).toBe(1);

    const outputBytes = await readFile(outputPath);
    const outputDoc = await PDFDocument.load(outputBytes);
    expect(outputDoc.getPageCount()).toBe(1);
  });

  it("should generate default output path with _searchable suffix", async () => {
    const inputPath = await createTestPdf("default-path.pdf", "Test");

    const result = await pipeline.convert({
      inputPath,
      chromePath: CHROME_PATH,
    });

    expect(result.outputPath).toContain("_searchable.pdf");

    const outputStat = await stat(result.outputPath);
    expect(outputStat.size).toBeGreaterThan(0);
  });

  it("should handle multi-page input PDF (outputs first page)", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(
      (await import("pdf-lib")).StandardFonts.Helvetica,
    );
    const page1 = doc.addPage([595.28, 841.89]);
    page1.drawText("Page 1", { x: 72, y: 720, size: 12, font });
    const page2 = doc.addPage([595.28, 841.89]);
    page2.drawText("Page 2", { x: 72, y: 720, size: 12, font });

    const pdfBytes = await doc.save();
    const inputPath = join(tempDir, "multi-input.pdf");
    await writeFile(inputPath, pdfBytes);
    const outputPath = join(tempDir, "multi-output.pdf");

    const result = await pipeline.convert({
      inputPath,
      outputPath,
      chromePath: CHROME_PATH,
    });

    expect(result.pageCount).toBe(2);

    const outputStat = await stat(outputPath);
    expect(outputStat.size).toBeGreaterThan(0);

    const outputBytes = await readFile(outputPath);
    const outputDoc = await PDFDocument.load(outputBytes);
    expect(outputDoc.getPageCount()).toBeGreaterThanOrEqual(1);
  });
});
