import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface RunCliOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeout?: number;
}

export interface RunCliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../..");
const cliPath = resolve(repoRoot, "dist/cli.js");

async function assertBuiltCliExists(): Promise<void> {
  try {
    await access(cliPath, constants.R_OK);
  } catch {
    throw new Error(
      `Built CLI binary not found at ${cliPath}. Run "npm run build" before running E2E tests.`,
    );
  }
}

export async function runCli(
  args: string[],
  options: RunCliOptions = {},
): Promise<RunCliResult> {
  await assertBuiltCliExists();

  return new Promise<RunCliResult>((resolveResult) => {
    execFile(
      process.execPath,
      [cliPath, ...args],
      {
        cwd: options.cwd ?? repoRoot,
        env: {
          ...process.env,
          ...options.env,
        },
        timeout: options.timeout ?? 120_000,
        maxBuffer: 10 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const exitCode =
          error && typeof error.code === "number" ? error.code : error ? 1 : 0;

        resolveResult({
          stdout,
          stderr,
          exitCode,
        });
      },
    );
  });
}
