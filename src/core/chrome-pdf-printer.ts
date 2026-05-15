import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { stat } from "node:fs/promises";
import type { IChromePdfPrinter } from "../types/index.js";

const DEFAULT_CHROME_PATHS: Record<string, string[]> = {
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ],
  linux: [
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
  ],
  win32: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ],
};

export class ChromePdfPrinter implements IChromePdfPrinter {
  async printToPdf(
    inputPath: string,
    outputPath: string,
    options?: { chromePath?: string; verbose?: boolean },
  ): Promise<void> {
    const chromePath = options?.chromePath ?? (await this.findChrome());
    if (!chromePath) {
      throw new Error(
        "Chrome/Chromium not found. Please specify --chrome-path.",
      );
    }

    const absoluteInput = resolve(inputPath);
    const absoluteOutput = resolve(outputPath);
    const fileUrl = `file://${absoluteInput}`;

    const args = [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--print-to-pdf=" + absoluteOutput,
      "--print-to-pdf-no-header",
      fileUrl,
    ];

    if (options?.verbose) {
      console.error(`[ChromePdfPrinter] Spawning: ${chromePath} ${args.join(" ")}`);
    }

    await this.runChrome(chromePath, args);

    const statResult = await stat(absoluteOutput);
    if (statResult.size === 0) {
      throw new Error("Chrome produced an empty PDF file");
    }
  }

  private runChrome(chromePath: string, args: string[]): Promise<void> {
    return new Promise((resolvePromise, reject) => {
      const proc = spawn(chromePath, args, {
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stderr = "";
      proc.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        if (code === 0) {
          resolvePromise();
        } else {
          reject(
            new Error(
              `Chrome exited with code ${code}: ${stderr.slice(0, 500)}`,
            ),
          );
        }
      });

      proc.on("error", (err) => {
        reject(new Error(`Failed to spawn Chrome: ${err.message}`));
      });
    });
  }

  private async findChrome(): Promise<string | undefined> {
    const platform = process.platform as string;
    const paths = DEFAULT_CHROME_PATHS[platform] ?? [];

    for (const p of paths) {
      try {
        await stat(p);
        return p;
      } catch {
        continue;
      }
    }

    return undefined;
  }
}
