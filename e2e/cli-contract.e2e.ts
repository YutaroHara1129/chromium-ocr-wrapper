import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { access, mkdir, readFile, symlink } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "./helpers/run-cli.js";
import {
  cleanupDir,
  createTempDir,
  createTextPdf,
  writeInvalidPdf,
} from "./helpers/pdf-fixtures.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const cliPath = resolve(repoRoot, "dist/cli.js");
const packageJsonPath = resolve(repoRoot, "package.json");

async function readPackageJson(): Promise<{
  version: string;
  bin: Record<string, string>;
}> {
  const raw = await readFile(packageJsonPath, "utf8");
  return JSON.parse(raw) as { version: string; bin: Record<string, string> };
}

function execNodeScript(scriptPath: string, args: string[]): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}> {
  return new Promise((resolveResult) => {
    execFile(
      process.execPath,
      [scriptPath, ...args],
      {
        cwd: repoRoot,
        timeout: 30_000,
      },
      (error, stdout, stderr) => {
        resolveResult({
          stdout,
          stderr,
          exitCode:
            error && typeof error.code === "number" ? error.code : error ? 1 : 0,
        });
      },
    );
  });
}

describe("CLI contract", () => {
  const tempDirs: string[] = [];

  async function makeTempDir(): Promise<string> {
    const tempDir = await createTempDir();
    tempDirs.push(tempDir);
    return tempDir;
  }

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((tempDir) => cleanupDir(tempDir)));
  });

  it("binary exists and --version prints package version", async () => {
    const pkg = await readPackageJson();

    await expect(access(cliPath, constants.R_OK)).resolves.toBeUndefined();

    const result = await runCli(["--version"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(pkg.version);
    expect(result.stderr).toBe("");
  });

  it("--help prints usage with all options", async () => {
    const result = await runCli(["--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage:");
    expect(result.stdout).toContain("chromium-ocr");
    expect(result.stdout).toContain("--version");
    expect(result.stdout).toContain("-o, --output <path>");
    expect(result.stdout).toContain("--chrome-path <path>");
    expect(result.stdout).toContain("--overwrite");
    expect(result.stdout).toContain("-v, --verbose");
    expect(result.stdout).toContain("-h, --help");
    expect(result.stderr).toBe("");
  });

  it("missing input exits non-zero with error message", async () => {
    const result = await runCli([]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/missing required argument|error/i);
  });

  it('no matching glob exits non-zero with "No PDF files found"', async () => {
    const tempDir = await makeTempDir();

    const result = await runCli([join(tempDir, "*.pdf")]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("No PDF files found");
  });

  it("invalid PDF exits non-zero and reports failure in stderr", async () => {
    const tempDir = await makeTempDir();
    const invalidPdf = await writeInvalidPdf(join(tempDir, "invalid.pdf"));

    const result = await runCli([
      invalidPdf,
      "--chrome-path",
      "/nonexistent/chrome",
    ]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Failed:");
    expect(result.stderr).toContain("invalid.pdf");
  });

  it("non-PDF glob matches are ignored", async () => {
    const tempDir = await makeTempDir();

    const result = await runCli([join(tempDir, "*.txt")]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("No PDF files found");
  });

  it("output path option is accepted", async () => {
    const tempDir = await makeTempDir();
    const inputPdf = await createTextPdf(join(tempDir, "input.pdf"), "Input");
    const outputPdf = join(tempDir, "custom-output.pdf");

    const result = await runCli([
      inputPdf,
      "--output",
      outputPdf,
      "--chrome-path",
      "/nonexistent/chrome",
    ]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Failed:");
    expect(result.stderr).toContain("input.pdf");
    expect(result.stderr).not.toContain("unknown option");
  });

  it("multiple files continue after one failure", async () => {
    const tempDir = await makeTempDir();

    await writeInvalidPdf(join(tempDir, "invalid.pdf"));
    await createTextPdf(join(tempDir, "valid.pdf"), "Valid PDF");

    const result = await runCli([
      join(tempDir, "*.pdf"),
      "--chrome-path",
      "/nonexistent/chrome",
    ]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("invalid.pdf");
    expect(result.stderr).toContain("valid.pdf");
  });

  it("package bin aliases both work", async () => {
    const pkg = await readPackageJson();
    const tempDir = await makeTempDir();
    const binDir = join(tempDir, "bin");

    await mkdir(binDir, { recursive: true });

    for (const [alias, target] of Object.entries(pkg.bin)) {
      expect(target).toBe("dist/cli.js");

      const aliasPath = join(binDir, alias);
      await symlink(cliPath, aliasPath);

      const result = await execNodeScript(aliasPath, ["--version"]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe(pkg.version);
      expect(result.stderr).toBe("");
    }

    expect(Object.keys(pkg.bin).sort()).toEqual([
      "chromium-ocr",
      "chromium-ocr-wrapper",
    ]);
  });
});
