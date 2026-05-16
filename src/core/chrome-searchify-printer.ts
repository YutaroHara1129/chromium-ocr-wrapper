import { chromium } from "playwright-core";
import { spawn, type ChildProcess } from "node:child_process";
import { cp, mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import type { Browser, Frame } from "playwright-core";
import type { IChromeSearchifyPrinter } from "../types/index.js";

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

export class ChromeSearchifyPrinter implements IChromeSearchifyPrinter {
  private browser: Browser | null = null;
  private chromeProcess: ChildProcess | null = null;
  private profileDir: string | null = null;
  private cdpPort = 9222 + Math.floor(Math.random() * 1000);

  async searchify(
    inputPath: string,
    options?: { chromePath?: string; verbose?: boolean },
  ): Promise<Uint8Array> {
    const chromePath =
      options?.chromePath ?? (await this.findChrome());
    if (!chromePath) {
      throw new Error(
        "Chrome/Chromium not found. Please specify --chrome-path.",
      );
    }

    this.profileDir = await this.setupProfile();
    this.cdpPort = 9222 + Math.floor(Math.random() * 1000);

    if (options?.verbose) {
      console.error(
        `[ChromeSearchifyPrinter] Launching Chrome on port ${this.cdpPort}`,
      );
    }

    this.chromeProcess = spawn(
      chromePath,
      [
        `--remote-debugging-port=${this.cdpPort}`,
        "--remote-debugging-address=127.0.0.1",
        `--user-data-dir=${this.profileDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--enable-features=PdfSearchify,PdfSearchifySave",
        "--disable-gpu",
      ],
      { stdio: ["ignore", "pipe", "pipe"], detached: false },
    );

    await this.waitForCdp(this.cdpPort);

    this.browser = await chromium.connectOverCDP(
      `http://127.0.0.1:${this.cdpPort}`,
    );

    const contexts = this.browser.contexts();
    const context = contexts[0]!;
    const page = await context.newPage();

    const fileUrl = pathToFileURL(inputPath).href;
    await page.goto(fileUrl, { waitUntil: "load", timeout: 15_000 });
    await page.waitForTimeout(3000);

    const frames = page.frames();
    if (options?.verbose) {
      console.error(
        `[ChromeSearchifyPrinter] Found ${frames.length} frames`,
      );
    }

    const viewerFrame = frames[1];
    if (!viewerFrame) {
      throw new Error("PDF viewer frame not found");
    }

    const searchifyReady = await this.waitForSearchify(
      viewerFrame,
      options?.verbose,
    );

    if (!searchifyReady && options?.verbose) {
      console.error(
        "[ChromeSearchifyPrinter] OCR not detected, attempting save anyway",
      );
    }

    const saveResult = await viewerFrame.evaluate(
      async (searchifyOk: boolean): Promise<{ dataToSave: number[]; fileName: string } | null> => {
        const viewer = (globalThis as Record<string, unknown>)["viewer"];
        if (!viewer || typeof viewer !== "object") return null;

        const ctrl = (viewer as Record<string, unknown>)["currentController"];
        if (!ctrl || typeof ctrl !== "object") return null;

        const ctrlObj = ctrl as Record<string, unknown>;
        const origHandle = (ctrlObj["handlePluginMessage_"] as Function).bind(ctrl);
        ctrlObj["handlePluginMessage_"] = function (msg: unknown) {
          return (origHandle as Function)(msg);
        };

        try {
          const saveType = searchifyOk ? "SEARCHIFIED" : "ORIGINAL";
          const result = await Promise.race([
            (ctrlObj["save"] as Function).call(ctrl, saveType),
            new Promise<null>((resolve) =>
              setTimeout(() => resolve(null), 15_000),
            ),
          ]);

          if (result && (result as Record<string, unknown>)["dataToSave"]) {
            const r = result as { dataToSave: ArrayBuffer; fileName: string };
            return {
              dataToSave: Array.from(new Uint8Array(r.dataToSave)),
              fileName: r.fileName,
            };
          }

          if (saveType === "SEARCHIFIED") {
            const originalResult = await Promise.race([
              (ctrlObj["save"] as Function).call(ctrl, "ORIGINAL"),
              new Promise<null>((resolve) =>
                setTimeout(() => resolve(null), 15_000),
              ),
            ]);
            if (originalResult && (originalResult as Record<string, unknown>)["dataToSave"]) {
              const or = originalResult as { dataToSave: ArrayBuffer; fileName: string };
              return {
                dataToSave: Array.from(new Uint8Array(or.dataToSave)),
                fileName: or.fileName,
              };
            }
          }
        } catch {
          // save failed
        }

        return null;
      },
      searchifyReady,
    );

    await page.close();

    if (saveResult && saveResult.dataToSave.length > 0) {
      return new Uint8Array(saveResult.dataToSave);
    }

    if (options?.verbose) {
      console.error(
        "[ChromeSearchifyPrinter] Save returned no data, returning original PDF",
      );
    }
    const { readFile } = await import("node:fs/promises");
    const originalBytes = await readFile(inputPath);
    return new Uint8Array(originalBytes);
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close().catch(() => undefined);
      this.browser = null;
    }
    if (this.chromeProcess) {
      this.chromeProcess.kill();
      this.chromeProcess = null;
    }
    if (this.profileDir) {
      await rm(this.profileDir, { recursive: true, force: true }).catch(
        () => undefined,
      );
      this.profileDir = null;
    }
  }

  private async waitForSearchify(
    viewerFrame: Frame,
    verbose?: boolean,
  ): Promise<boolean> {
    for (let attempt = 0; attempt < 10; attempt++) {
      const info = await viewerFrame.evaluate(() => {
        const v = (globalThis as Record<string, unknown>)["viewer"] as Record<string, unknown> | undefined;
        return {
          hasSearchifyText: (v?.["hasSearchifyText_"] as boolean) ?? false,
          pdfSearchifySaveEnabled: (v?.["pdfSearchifySaveEnabled_"] as boolean) ?? false,
        };
      });

      if (verbose) {
        console.error(
          `[ChromeSearchifyPrinter] OCR check attempt ${attempt + 1}:`,
          info,
        );
      }

      if (info.hasSearchifyText) {
        return true;
      }

      await new Promise((r) => setTimeout(r, 1000));
    }
    return false;
  }

  private async setupProfile(): Promise<string> {
    const profileDir = await mkdtemp(join(tmpdir(), "chromium-ocr-"));
    const homeDir = process.env.HOME ?? "";

    const screenAiSrc = `${homeDir}/Library/Application Support/Google/Chrome/screen_ai`;
    const localStateSrc = `${homeDir}/Library/Application Support/Google/Chrome/Local State`;

    await cp(screenAiSrc, `${profileDir}/screen_ai`, {
      recursive: true,
    }).catch(() => undefined);
    await cp(localStateSrc, `${profileDir}/Local State`).catch(
      () => undefined,
    );

    return profileDir;
  }

  private waitForCdp(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      let attempts = 0;
      const maxAttempts = 50;
      const interval = setInterval(async () => {
        attempts++;
        try {
          const resp = await fetch(`http://127.0.0.1:${port}/json/version`);
          if (resp.ok) {
            clearInterval(interval);
            resolve();
          }
        } catch {
          if (attempts >= maxAttempts) {
            clearInterval(interval);
            reject(new Error("Chrome CDP connection timed out"));
          }
        }
      }, 200);
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
