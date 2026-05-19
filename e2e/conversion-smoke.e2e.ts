import { afterEach, describe, expect, it } from "vitest";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument } from "pdf-lib";
import { runCli } from "./helpers/run-cli.js";
import {
  cleanupDir,
  createMultiPagePdf,
  createTempDir,
  createTextPdf,
} from "./helpers/pdf-fixtures.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

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
    const inputPdf = resolve(__dirname, "fixtures/unprocessed.pdf");
    const outputPdf = join(tempDir, "output.pdf");

    const result = await runCli([inputPdf, "--output", outputPdf]);

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

    expect(outputBytes.equals(inputBytes)).toBe(false);
  });
});
