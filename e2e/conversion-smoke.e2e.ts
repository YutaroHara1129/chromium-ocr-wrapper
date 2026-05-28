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
  createLargePdf,
  isObjStmPdf,
} from "./helpers/pdf-fixtures.js";

describe("CLI conversion smoke", () => {
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

  function countFontObjects(pdfBytes: Buffer): number {
    const text = pdfBytes.toString("latin1");
    return (text.match(/\/Type\s*\/Font[^s]/g) || []).length;
  }

  async function getPageFontCounts(pdfBytes: Buffer): Promise<number[]> {
    const doc = await PDFDocument.load(pdfBytes);
    return doc.getPages().map((page) => {
      const resources = page.node.lookup(PDFName.of("Resources"));
      if (!(resources instanceof PDFDict)) return 0;
      const fonts = resources.lookup(PDFName.of("Font"));
      return fonts instanceof PDFDict ? fonts.size() : 0;
    });
  }

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((tempDir) => cleanupDir(tempDir)));
  });

  it("converts a valid text PDF through CLI", async () => {
    const tempDir = await makeTempDir();
    const inputPdf = await createMultiPagePdf(join(tempDir, "input.pdf"), [
      "Page one",
      "Page two",
    ]);
    const outputPdf = join(tempDir, "output.pdf");

    const result = await runCli([inputPdf, "--output", outputPdf]);

    expect(result, `exitCode=${result.exitCode} stderr=${result.stderr} stdout=${result.stdout}`).toMatchObject({ exitCode: 0 });
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Done:");
    expect(result.stdout).toContain("2 pages");

    await expect(stat(outputPdf)).resolves.toMatchObject({
      isFile: expect.any(Function),
    });
    expect(await getPageCount(outputPdf)).toBe(2);
  });

  it("generates default output path with _searchable suffix", async () => {
    const tempDir = await makeTempDir();
    const inputPdf = await createTextPdf(join(tempDir, "default.pdf"), "Default");

    const result = await runCli([inputPdf]);

    const outputPdf = join(tempDir, "default_searchable.pdf");

    expect(result, `exitCode=${result.exitCode} stderr=${result.stderr} stdout=${result.stdout}`).toMatchObject({ exitCode: 0 });
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(outputPdf);

    const outputStat = await stat(outputPdf);
    const diagnostics = `outputPdf=${outputPdf} exitCode=${result.exitCode} stderr=${result.stderr} stdout=${result.stdout}`;

    expect(outputStat.size, diagnostics).toBeGreaterThan(0);
    expect(await getPageCount(outputPdf)).toBe(1);
  });

  it("rejects existing output without --overwrite", async () => {
    const tempDir = await makeTempDir();
    const inputPdf = await createTextPdf(join(tempDir, "input.pdf"), "Input");
    const outputPdf = join(tempDir, "existing.pdf");

    await createTextPdf(outputPdf, "Already exists");

    const result = await runCli([inputPdf, "--output", outputPdf]);

    const diagnostics = `exitCode=${result.exitCode} stderr=${result.stderr} stdout=${result.stdout}`;

    expect(result, diagnostics).toMatchObject({ exitCode: 1 });
    expect(result.stderr, diagnostics).toContain("Failed:");
    expect(result.stderr, diagnostics).toMatch(/Output already exists: .* Use --overwrite to replace\./);
  });

  it("overwrites existing output with --overwrite", async () => {
    const tempDir = await makeTempDir();
    const inputPdf = await createTextPdf(join(tempDir, "input.pdf"), "Input");
    const outputPdf = join(tempDir, "existing.pdf");

    await writeFile(outputPdf, Buffer.from("old output", "utf8"));

    const result = await runCli([
      inputPdf,
      "--output",
      outputPdf,
      "--overwrite",
    ]);

    expect(result, `exitCode=${result.exitCode} stderr=${result.stderr} stdout=${result.stdout}`).toMatchObject({ exitCode: 0 });
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Done:");

    const outputStat = await stat(outputPdf);
    expect(outputStat.size).toBeGreaterThan(0);
    expect(await getPageCount(outputPdf)).toBe(1);
  });

  it("uses output directory for glob input", async () => {
    const tempDir = await makeTempDir();
    const outputDir = join(tempDir, "out");

    await mkdir(outputDir, { recursive: true });
    await createTextPdf(join(tempDir, "one.pdf"), "One");
    await createTextPdf(join(tempDir, "two.pdf"), "Two");

    const result = await runCli([join(tempDir, "*.pdf"), "--output", outputDir]);

    expect(result, `exitCode=${result.exitCode} stderr=${result.stderr} stdout=${result.stdout}`).toMatchObject({ exitCode: 0 });
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("one.pdf");
    expect(result.stdout).toContain("two.pdf");

    const oneOutput = join(outputDir, "one_searchable.pdf");
    const twoOutput = join(outputDir, "two_searchable.pdf");

    expect((await stat(oneOutput)).size).toBeGreaterThan(0);
    expect((await stat(twoOutput)).size).toBeGreaterThan(0);
    expect(await getPageCount(oneOutput)).toBe(1);
    expect(await getPageCount(twoOutput)).toBe(1);
  });

  it("converts an image-only PDF to searchable PDF with OCR text layer", async () => {
    const tempDir = await makeTempDir();
    const inputPdf = await createImagePdf(join(tempDir, "input.pdf"), 3);
    const outputPdf = join(tempDir, "output.pdf");

    const result = await runCli(
      [inputPdf, "--output", outputPdf],
      { timeout: 120_000 },
    );

    const diagnostics = `exitCode=${result.exitCode} stderr=${result.stderr} stdout=${result.stdout}`;
    expect(result, diagnostics).toMatchObject({ exitCode: 0 });
    expect(result.stderr, diagnostics).toBe("");
    expect(result.stdout, diagnostics).toContain("Done:");
    expect(result.stdout, diagnostics).toContain("3 pages");

    const outputBytes = await readFile(outputPdf);
    const inputBytes = await readFile(inputPdf);

    const doc = await PDFDocument.load(outputBytes);
    expect(doc.getPageCount()).toBe(3);

    const fontCount = countFontObjects(outputBytes);
    expect(fontCount, `${fontCount} font objects found, expected > 0`).toBeGreaterThan(0);

    const pageFontCounts = await getPageFontCounts(outputBytes);
    expect(pageFontCounts, `font resources per page: ${pageFontCounts.join(", ")}`).toHaveLength(3);
    expect(
      pageFontCounts.every((c) => c > 0),
      `expected all 3 pages to have font resources, got: ${pageFontCounts.join(", ")}`,
    ).toBe(true);

    expect(outputBytes.equals(inputBytes)).toBe(false);
  }, 120_000);

  it("converts a 50-page ObjStm-compressed PDF through the pipeline", async () => {
    const PAGE_COUNT = 50;
    const tempDir = await makeTempDir();
    const inputPdf = await createLargePdf(join(tempDir, "large.pdf"), PAGE_COUNT);
    const outputPdf = join(tempDir, "output.pdf");

    const inputBytes = await readFile(inputPdf);
    expect(isObjStmPdf(inputBytes), "input PDF must use ObjStm compression").toBe(true);

    const result = await runCli(
      [inputPdf, "--output", outputPdf],
      { timeout: 600_000 },
    );

    const diagnostics = `exitCode=${result.exitCode} stderr=${result.stderr} stdout=${result.stdout}`;
    expect(result, diagnostics).toMatchObject({ exitCode: 0 });
    expect(result.stderr, diagnostics).toBe("");
    expect(result.stdout, diagnostics).toContain("Done:");
    expect(result.stdout, diagnostics).toContain(`${PAGE_COUNT} pages`);

    const outputBytes = await readFile(outputPdf);
    expect(outputBytes.length, "output file must not be empty").toBeGreaterThan(0);

    const doc = await PDFDocument.load(outputBytes);
    expect(doc.getPageCount()).toBe(PAGE_COUNT);

    const fontCount = countFontObjects(outputBytes);
    expect(fontCount, `${fontCount} font objects found, expected > 0`).toBeGreaterThan(0);
  }, 600_000);

  it("converts multiple explicit file paths into an output directory", async () => {
    const tempDir = await makeTempDir();
    const outputDir = join(tempDir, "out");
    await mkdir(outputDir, { recursive: true });
    await createTextPdf(join(tempDir, "one.pdf"), "One");
    await createTextPdf(join(tempDir, "two.pdf"), "Two");

    const result = await runCli([
      join(tempDir, "one.pdf"),
      join(tempDir, "two.pdf"),
      "--output",
      outputDir,
    ]);

    const diagnostics = `exitCode=${result.exitCode} stderr=${result.stderr} stdout=${result.stdout}`;
    expect(result, diagnostics).toMatchObject({ exitCode: 0 });
    expect(result.stderr, diagnostics).toBe("");
    expect(result.stdout, diagnostics).toContain("Done:");

    const oneOutput = join(outputDir, "one_searchable.pdf");
    const twoOutput = join(outputDir, "two_searchable.pdf");

    expect((await stat(oneOutput)).size).toBeGreaterThan(0);
    expect((await stat(twoOutput)).size).toBeGreaterThan(0);
    expect(await getPageCount(oneOutput)).toBe(1);
    expect(await getPageCount(twoOutput)).toBe(1);
  }, 120_000);

  it("converts directory input recursively preserving subdirectory structure", async () => {
    const tempDir = await makeTempDir();
    const inputDir = join(tempDir, "input");
    const nestedDir = join(inputDir, "sub");
    const outputDir = join(tempDir, "out");
    await mkdir(nestedDir, { recursive: true });
    await mkdir(outputDir, { recursive: true });
    await createTextPdf(join(inputDir, "root.pdf"), "Root");
    await createTextPdf(join(nestedDir, "child.pdf"), "Child");

    const result = await runCli([inputDir, "--output", outputDir]);

    const diagnostics = `exitCode=${result.exitCode} stderr=${result.stderr} stdout=${result.stdout}`;
    expect(result, diagnostics).toMatchObject({ exitCode: 0 });
    expect(result.stderr, diagnostics).toBe("");
    expect(result.stdout, diagnostics).toContain("Done:");

    const rootOutput = join(outputDir, "root_searchable.pdf");
    const childOutput = join(outputDir, "sub", "child_searchable.pdf");

    expect((await stat(rootOutput)).size).toBeGreaterThan(0);
    expect((await stat(childOutput)).size).toBeGreaterThan(0);
    expect(await getPageCount(rootOutput)).toBe(1);
    expect(await getPageCount(childOutput)).toBe(1);
  }, 120_000);

  it("converts multiple inputs with default output paths next to each input", async () => {
    const tempDir = await makeTempDir();
    const oneInput = await createTextPdf(join(tempDir, "one.pdf"), "One");
    const twoInput = await createTextPdf(join(tempDir, "two.pdf"), "Two");

    const result = await runCli([oneInput, twoInput]);

    const diagnostics = `exitCode=${result.exitCode} stderr=${result.stderr} stdout=${result.stdout}`;
    expect(result, diagnostics).toMatchObject({ exitCode: 0 });
    expect(result.stderr, diagnostics).toBe("");

    const oneOutput = join(tempDir, "one_searchable.pdf");
    const twoOutput = join(tempDir, "two_searchable.pdf");

    expect((await stat(oneOutput)).size).toBeGreaterThan(0);
    expect((await stat(twoOutput)).size).toBeGreaterThan(0);
    expect(await getPageCount(oneOutput)).toBe(1);
    expect(await getPageCount(twoOutput)).toBe(1);
  }, 120_000);

  it("continues converting remaining files when one output already exists", async () => {
    const tempDir = await makeTempDir();
    const outputDir = join(tempDir, "out");
    await mkdir(outputDir, { recursive: true });
    await createImagePdf(join(tempDir, "one.pdf"), 1);
    await createImagePdf(join(tempDir, "two.pdf"), 1);
    await createImagePdf(join(outputDir, "one_searchable.pdf"), 1);

    const result = await runCli([
      join(tempDir, "one.pdf"),
      join(tempDir, "two.pdf"),
      "--output",
      outputDir,
    ]);

    const diagnostics = `exitCode=${result.exitCode} stderr=${result.stderr} stdout=${result.stdout}`;
    expect(result, diagnostics).toMatchObject({ exitCode: 1 });
    expect(result.stderr, diagnostics).toContain("Failed:");
    expect(result.stderr, diagnostics).toContain("one_searchable.pdf");
    expect(result.stdout, diagnostics).toContain("Done:");

    const twoOutput = join(outputDir, "two_searchable.pdf");
    expect((await stat(twoOutput)).size).toBeGreaterThan(0);
    expect(await getPageCount(twoOutput)).toBe(1);
  }, 120_000);

  it("single text-only PDF is passed through", async () => {
    const tempDir = await makeTempDir();
    const inputPdf = await createTextPdf(join(tempDir, "input.pdf"), "Text only");
    const outputPdf = join(tempDir, "output.pdf");

    const result = await runCli([inputPdf, "--output", outputPdf]);

    const diagnostics = `exitCode=${result.exitCode} stderr=${result.stderr} stdout=${result.stdout}`;
    expect(result, diagnostics).toMatchObject({ exitCode: 0 });
    expect(result.stderr, diagnostics).toBe("");
    expect((await stat(outputPdf)).size, diagnostics).toBeGreaterThan(0);
  }, 120_000);

  it("single blank PDF is passed through", async () => {
    const tempDir = await makeTempDir();
    const inputPdf = await createBlankPdf(join(tempDir, "input.pdf"), 1);
    const outputPdf = join(tempDir, "output.pdf");

    const result = await runCli([inputPdf, "--output", outputPdf]);

    const diagnostics = `exitCode=${result.exitCode} stderr=${result.stderr} stdout=${result.stdout}`;
    expect(result, diagnostics).toMatchObject({ exitCode: 0 });
    expect(result.stderr, diagnostics).toBe("");
    expect((await stat(outputPdf)).size, diagnostics).toBeGreaterThan(0);
  }, 120_000);

  it("single mixed text+image PDF", async () => {
    const tempDir = await makeTempDir();
    const inputPdf = await createMixedPdf(join(tempDir, "input.pdf"), {
      textPages: 1,
      imagePages: 1,
      mixedPages: 1,
    });
    const outputPdf = join(tempDir, "output.pdf");

    const result = await runCli(
      [inputPdf, "--output", outputPdf],
      { timeout: 120_000 },
    );

    const diagnostics = `exitCode=${result.exitCode} stderr=${result.stderr} stdout=${result.stdout}`;
    expect(result, diagnostics).toMatchObject({ exitCode: 0 });
    expect(result.stderr, diagnostics).toBe("");
    expect((await stat(outputPdf)).size, diagnostics).toBeGreaterThan(0);

    const outputBytes = await readFile(outputPdf);
    const fontCount = countFontObjects(outputBytes);
    expect(fontCount, `${fontCount} font objects found, expected > 0`).toBeGreaterThan(0);
  }, 120_000);

  it("multiple image-only PDFs are all converted", async () => {
    const tempDir = await makeTempDir();
    const outputDir = join(tempDir, "out");
    await mkdir(outputDir, { recursive: true });
    await createImagePdf(join(tempDir, "one.pdf"), 3);
    await createImagePdf(join(tempDir, "two.pdf"), 3);

    const result = await runCli([
      join(tempDir, "one.pdf"),
      join(tempDir, "two.pdf"),
      "--output",
      outputDir,
    ]);

    const diagnostics = `exitCode=${result.exitCode} stderr=${result.stderr} stdout=${result.stdout}`;
    expect(result, diagnostics).toMatchObject({ exitCode: 0 });
    expect(result.stderr, diagnostics).toBe("");

    const oneOutput = join(outputDir, "one_searchable.pdf");
    const twoOutput = join(outputDir, "two_searchable.pdf");

    expect((await stat(oneOutput)).size, diagnostics).toBeGreaterThan(0);
    expect((await stat(twoOutput)).size, diagnostics).toBeGreaterThan(0);

    for (const outputPdf of [oneOutput, twoOutput]) {
      const outputBytes = await readFile(outputPdf);
      const fontCount = countFontObjects(outputBytes);
      expect(
        fontCount,
        `${outputPdf}: ${fontCount} font objects found, expected > 0`,
      ).toBeGreaterThan(0);
    }
  }, 120_000);

  it("heterogeneous: image, text, and blank PDFs all succeed", async () => {
    const tempDir = await makeTempDir();
    const outputDir = join(tempDir, "out");
    await mkdir(outputDir, { recursive: true });

    await createImagePdf(join(tempDir, "image.pdf"), 1);
    await createTextPdf(join(tempDir, "text.pdf"), "Text");
    await createBlankPdf(join(tempDir, "blank.pdf"), 1);

    const result = await runCli([
      join(tempDir, "image.pdf"),
      join(tempDir, "text.pdf"),
      join(tempDir, "blank.pdf"),
      "--output",
      outputDir,
    ]);

    const diagnostics = `exitCode=${result.exitCode} stderr=${result.stderr} stdout=${result.stdout}`;
    expect(result, diagnostics).toMatchObject({ exitCode: 0 });
    expect(result.stderr, diagnostics).toBe("");

    expect(
      (await stat(join(outputDir, "image_searchable.pdf"))).size,
      diagnostics,
    ).toBeGreaterThan(0);
    expect(
      (await stat(join(outputDir, "text_searchable.pdf"))).size,
      diagnostics,
    ).toBeGreaterThan(0);
    expect(
      (await stat(join(outputDir, "blank_searchable.pdf"))).size,
      diagnostics,
    ).toBeGreaterThan(0);
  }, 120_000);

  it("image-only PDF with 10 pages", async () => {
    const tempDir = await makeTempDir();
    const inputPdf = await createImagePdf(join(tempDir, "input.pdf"), 10);
    const outputPdf = join(tempDir, "output.pdf");

    const result = await runCli(
      [inputPdf, "--output", outputPdf],
      { timeout: 120_000 },
    );

    const diagnostics = `exitCode=${result.exitCode} stderr=${result.stderr} stdout=${result.stdout}`;
    expect(result, diagnostics).toMatchObject({ exitCode: 0 });
    expect(result.stderr, diagnostics).toBe("");
    expect(await getPageCount(outputPdf)).toBe(10);

    const outputBytes = await readFile(outputPdf);
    const fontCount = countFontObjects(outputBytes);
    expect(fontCount, `${fontCount} font objects found, expected > 0`).toBeGreaterThan(0);
  }, 120_000);
});
