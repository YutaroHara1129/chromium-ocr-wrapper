import { afterEach, describe, expect, it } from "vitest";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PDFDocument, PDFDict, PDFName } from "pdf-lib";
import { runCli } from "./helpers/run-cli.js";
import {
  cleanupDir,
  createBlankPdf,
  createImagePdf,
  createMixedPdf,
  createMultiPagePdf,
  createTempDir,
  createTextPdf,
  writeInvalidPdf,
} from "./helpers/pdf-fixtures.js";

const OCR_BUFFER_MS = 20_000;
const CLI_OVERHEAD_MS = 40_000;
const CHUNK_SIZE = 50;
const CHUNK_OVERHEAD_MS = 25_000;

function testTimeout(pageCount: number): number {
  const additionalChunks = Math.max(0, Math.ceil(pageCount / CHUNK_SIZE) - 1);
  return (
    pageCount * 300 +
    OCR_BUFFER_MS +
    CLI_OVERHEAD_MS +
    additionalChunks * CHUNK_OVERHEAD_MS
  );
}

function countFontObjects(pdfBytes: Buffer): number {
  const text = pdfBytes.toString("latin1");
  return (text.match(/\/Type\s*\/Font[^s]/g) || []).length;
}

describe("E2E: OCR pipeline with real Chrome", () => {
  const tempDirs: string[] = [];

  async function makeTempDir(): Promise<string> {
    const tempDir = await createTempDir();
    tempDirs.push(tempDir);
    return tempDir;
  }

  async function getPageCount(filePath: string): Promise<number> {
    const bytes = await readFile(filePath);
    const doc = await PDFDocument.load(bytes);
    return doc.getPageCount();
  }

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((d) => cleanupDir(d)));
  });

  describe("single file — text-only", () => {
    it("1 page: passed through without OCR", async () => {
      const tempDir = await makeTempDir();
      const inputPdf = await createTextPdf(join(tempDir, "input.pdf"), "Hello");
      const outputPdf = join(tempDir, "output.pdf");

      const result = await runCli([inputPdf, "--output", outputPdf]);

      const diag = `exitCode=${result.exitCode} stderr=${result.stderr} stdout=${result.stdout}`;
      expect(result, diag).toMatchObject({ exitCode: 0 });
      expect(result.stdout, diag).toContain("OCR not needed");
      expect(await getPageCount(outputPdf)).toBe(1);
    }, testTimeout(1));

    it("250 pages: passed through without OCR", async () => {
      const PAGE_COUNT = 250;
      const tempDir = await makeTempDir();
      const pages = Array.from({ length: PAGE_COUNT }, (_, i) => `Page ${i + 1}`);
      const inputPdf = await createMultiPagePdf(join(tempDir, "input.pdf"), pages);
      const outputPdf = join(tempDir, "output.pdf");

      const result = await runCli(
        [inputPdf, "--output", outputPdf],
        { timeout: testTimeout(PAGE_COUNT) },
      );

      const diag = `exitCode=${result.exitCode} stderr=${result.stderr} stdout=${result.stdout}`;
      expect(result, diag).toMatchObject({ exitCode: 0 });
      expect(result.stdout, diag).toContain("OCR not needed");
      expect(result.stdout, diag).toContain(`${PAGE_COUNT} pages`);
      expect(await getPageCount(outputPdf)).toBe(PAGE_COUNT);
    }, testTimeout(250));
  });

  describe("single file — blank", () => {
    it("1 page: passed through without OCR", async () => {
      const tempDir = await makeTempDir();
      const inputPdf = await createBlankPdf(join(tempDir, "input.pdf"), 1);
      const outputPdf = join(tempDir, "output.pdf");

      const result = await runCli([inputPdf, "--output", outputPdf]);

      const diag = `exitCode=${result.exitCode} stderr=${result.stderr} stdout=${result.stdout}`;
      expect(result, diag).toMatchObject({ exitCode: 0 });
      expect(result.stdout, diag).toContain("OCR not needed");
      expect(await getPageCount(outputPdf)).toBe(1);
    }, testTimeout(1));
  });

  describe("single file — image-only", () => {
    it("1 page: OCR produces searchable text layer", async () => {
      const tempDir = await makeTempDir();
      const inputPdf = await createImagePdf(join(tempDir, "input.pdf"), 1);
      const outputPdf = join(tempDir, "output.pdf");

      const result = await runCli(
        [inputPdf, "--output", outputPdf, "--verbose"],
        { timeout: testTimeout(1) },
      );

      const diag = `exitCode=${result.exitCode} stderr=${result.stderr} stdout=${result.stdout}`;
      expect(result, diag).toMatchObject({ exitCode: 0 });
      expect(result.stdout, diag).toContain("Done:");
      expect(result.stdout, diag).toContain("pages verified");

      const outputBytes = await readFile(outputPdf);
      expect(outputBytes.length).toBeGreaterThan(0);
      expect(await getPageCount(outputPdf)).toBe(1);

      const fontCount = countFontObjects(outputBytes);
      expect(fontCount, `expected font objects, got ${fontCount}`).toBeGreaterThan(0);
    }, testTimeout(1));

    it("250 pages: full OCR pipeline completes with searchable text layer", async () => {
      const PAGE_COUNT = 250;
      const tempDir = await makeTempDir();
      const inputPdf = await createImagePdf(join(tempDir, "input.pdf"), PAGE_COUNT);
      const outputPdf = join(tempDir, "output.pdf");

      const result = await runCli(
        [inputPdf, "--output", outputPdf, "--verbose"],
        { timeout: testTimeout(PAGE_COUNT) },
      );

      const diag = `exitCode=${result.exitCode} stderr=${result.stderr} stdout=${result.stdout}`;
      expect(result, diag).toMatchObject({ exitCode: 0 });
      expect(result.stdout, diag).toContain("Done:");
      expect(result.stdout, diag).toContain(`${PAGE_COUNT} pages`);
      expect(result.stdout, diag).toContain("pages verified");

      const outputBytes = await readFile(outputPdf);
      expect(outputBytes.length, "output must not be empty").toBeGreaterThan(0);

      const doc = await PDFDocument.load(outputBytes);
      expect(doc.getPageCount(), "output page count must match input").toBe(PAGE_COUNT);

      const fontCount = countFontObjects(outputBytes);
      expect(fontCount, `expected font objects for text layer, got ${fontCount}`).toBeGreaterThan(0);
    }, testTimeout(250));
  });

  describe("single file — mixed", () => {
    it("1 page: mixed text+image produces valid output", async () => {
      const tempDir = await makeTempDir();
      const inputPdf = await createMixedPdf(join(tempDir, "input.pdf"), {
        textPages: 0,
        imagePages: 0,
        mixedPages: 1,
      });
      const outputPdf = join(tempDir, "output.pdf");

      const result = await runCli(
        [inputPdf, "--output", outputPdf, "--verbose"],
        { timeout: testTimeout(1) },
      );

      const diag = `exitCode=${result.exitCode} stderr=${result.stderr} stdout=${result.stdout}`;
      expect(result, diag).toMatchObject({ exitCode: 0 });
      expect(result.stdout, diag).toContain("Done:");
      expect((await stat(outputPdf)).size, diag).toBeGreaterThan(0);
      expect(await getPageCount(outputPdf)).toBe(1);
    }, testTimeout(1));

    it("250 pages: mixed text+image+blank produces valid output", async () => {
      const PAGE_COUNT = 250;
      const tempDir = await makeTempDir();
      const inputPdf = await createMixedPdf(join(tempDir, "input.pdf"), {
        textPages: 50,
        imagePages: 150,
        mixedPages: 50,
      });
      const outputPdf = join(tempDir, "output.pdf");

      const result = await runCli(
        [inputPdf, "--output", outputPdf, "--verbose"],
        { timeout: testTimeout(PAGE_COUNT) },
      );

      const diag = `exitCode=${result.exitCode} stderr=${result.stderr} stdout=${result.stdout}`;
      expect(result, diag).toMatchObject({ exitCode: 0 });
      expect(result.stdout, diag).toContain("Done:");
      expect(result.stdout, diag).toContain(`${PAGE_COUNT} pages`);
      expect(result.stdout, diag).toContain("pages verified");

      const outputBytes = await readFile(outputPdf);
      expect(outputBytes.length).toBeGreaterThan(0);
      expect(await getPageCount(outputPdf)).toBe(PAGE_COUNT);
    }, testTimeout(250));
  });

  describe("multiple files", () => {
    it("image-only (3p) + text-only (1p): sequential processing", async () => {
      const tempDir = await makeTempDir();
      const outputDir = join(tempDir, "out");
      await mkdir(outputDir, { recursive: true });

      const imgPdf = await createImagePdf(join(tempDir, "image.pdf"), 3);
      const txtPdf = await createTextPdf(join(tempDir, "text.pdf"), "Text");

      const result = await runCli(
        [imgPdf, txtPdf, "--output", outputDir],
        { timeout: testTimeout(3 + 1) },
      );

      const diag = `exitCode=${result.exitCode} stderr=${result.stderr} stdout=${result.stdout}`;
      expect(result, diag).toMatchObject({ exitCode: 0 });
      expect(result.stdout, diag).toContain("image.pdf");
      expect(result.stdout, diag).toContain("text.pdf");

      const imgOutput = join(outputDir, "image_searchable.pdf");
      const txtOutput = join(outputDir, "text_searchable.pdf");

      expect((await stat(imgOutput)).size, diag).toBeGreaterThan(0);
      expect((await stat(txtOutput)).size, diag).toBeGreaterThan(0);
      expect(await getPageCount(imgOutput)).toBe(3);
      expect(await getPageCount(txtOutput)).toBe(1);

      const imgFontCount = countFontObjects(await readFile(imgOutput));
      expect(imgFontCount, "image output should have font objects from OCR").toBeGreaterThan(0);
    }, testTimeout(4));

    it("image-only (3p) + image-only (3p): both produce OCR output", async () => {
      const tempDir = await makeTempDir();
      const outputDir = join(tempDir, "out");
      await mkdir(outputDir, { recursive: true });

      const one = await createImagePdf(join(tempDir, "one.pdf"), 3);
      const two = await createImagePdf(join(tempDir, "two.pdf"), 3);

      const result = await runCli(
        [one, two, "--output", outputDir],
        { timeout: testTimeout(6) },
      );

      const diag = `exitCode=${result.exitCode} stderr=${result.stderr} stdout=${result.stdout}`;
      expect(result, diag).toMatchObject({ exitCode: 0 });

      const oneOut = join(outputDir, "one_searchable.pdf");
      const twoOut = join(outputDir, "two_searchable.pdf");

      expect((await stat(oneOut)).size, diag).toBeGreaterThan(0);
      expect((await stat(twoOut)).size, diag).toBeGreaterThan(0);
      expect(countFontObjects(await readFile(oneOut)), "one.pdf OCR").toBeGreaterThan(0);
      expect(countFontObjects(await readFile(twoOut)), "two.pdf OCR").toBeGreaterThan(0);
    }, testTimeout(6));
  });

  describe("directory input", () => {
    it("image-only (1p) + text-only (1p) + blank (1p): heterogeneous files", async () => {
      const tempDir = await makeTempDir();
      const inputDir = join(tempDir, "input");
      const outputDir = join(tempDir, "out");
      await mkdir(inputDir, { recursive: true });
      await mkdir(outputDir, { recursive: true });

      await createImagePdf(join(inputDir, "image.pdf"), 1);
      await createTextPdf(join(inputDir, "text.pdf"), "Text");
      await createBlankPdf(join(inputDir, "blank.pdf"), 1);

      const result = await runCli(
        [inputDir, "--output", outputDir],
        { timeout: testTimeout(3) },
      );

      const diag = `exitCode=${result.exitCode} stderr=${result.stderr} stdout=${result.stdout}`;
      expect(result, diag).toMatchObject({ exitCode: 0 });
      expect(result.stdout, diag).toContain("image.pdf");
      expect(result.stdout, diag).toContain("text.pdf");
      expect(result.stdout, diag).toContain("blank.pdf");

      for (const name of ["image_searchable.pdf", "text_searchable.pdf", "blank_searchable.pdf"]) {
        const p = join(outputDir, name);
        expect((await stat(p)).size, `${name} should not be empty`).toBeGreaterThan(0);
      }

      const imgFontCount = countFontObjects(await readFile(join(outputDir, "image_searchable.pdf")));
      expect(imgFontCount, "image output should have font objects from OCR").toBeGreaterThan(0);
    }, testTimeout(3));

    it("image-only 250 pages: full OCR via directory path", async () => {
      const PAGE_COUNT = 250;
      const tempDir = await makeTempDir();
      const inputDir = join(tempDir, "input");
      const outputDir = join(tempDir, "out");
      await mkdir(inputDir, { recursive: true });
      await mkdir(outputDir, { recursive: true });

      await createImagePdf(join(inputDir, "large.pdf"), PAGE_COUNT);

      const result = await runCli(
        [inputDir, "--output", outputDir, "--verbose"],
        { timeout: testTimeout(PAGE_COUNT) },
      );

      const diag = `exitCode=${result.exitCode} stderr=${result.stderr} stdout=${result.stdout}`;
      expect(result, diag).toMatchObject({ exitCode: 0 });
      expect(result.stdout, diag).toContain("Done:");
      expect(result.stdout, diag).toContain(`${PAGE_COUNT} pages`);

      const outputPdf = join(outputDir, "large_searchable.pdf");
      const outputBytes = await readFile(outputPdf);
      expect(outputBytes.length).toBeGreaterThan(0);
      expect(await getPageCount(outputPdf)).toBe(PAGE_COUNT);

      const fontCount = countFontObjects(outputBytes);
      expect(fontCount, `expected font objects, got ${fontCount}`).toBeGreaterThan(0);
    }, testTimeout(250));
  });

  describe("error handling", () => {
    it("invalid PDF: exits non-zero with failure message", async () => {
      const tempDir = await makeTempDir();
      const invalidPdf = await writeInvalidPdf(join(tempDir, "invalid.pdf"));

      const result = await runCli([invalidPdf]);

      const diag = `exitCode=${result.exitCode} stderr=${result.stderr} stdout=${result.stdout}`;
      expect(result.exitCode, diag).not.toBe(0);
      expect(result.stderr, diag).toContain("Failed:");
      expect(result.stderr, diag).toContain("invalid.pdf");
    }, testTimeout(0));
  });
});
