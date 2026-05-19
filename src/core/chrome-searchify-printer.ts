import { chromium } from "playwright-core";
import { spawn, type ChildProcess } from "node:child_process";
import {
  copyFile,
  cp,
  mkdtemp,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import type { Browser, Frame, Page } from "playwright-core";
import type { IChromeSearchifyPrinter, SearchifyToFileOptions } from "../types/index.js";

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

type BrowserUploadResult =
  | { uploaded: true; fileName: string; byteLength: number; saveType: "SEARCHIFIED" | "ORIGINAL" }
  | { uploaded: false; reason: string; status?: number };

export class ChromeSearchifyPrinter implements IChromeSearchifyPrinter {
  private browser: Browser | null = null;
  private chromeProcess: ChildProcess | null = null;
  private profileDir: string | null = null;
  private cdpPort = 9222 + Math.floor(Math.random() * 1000);

  async searchifyToFile(
    inputPath: string,
    outputPath: string,
    options?: SearchifyToFileOptions,
  ): Promise<void> {
    const chromePath =
      options?.chromePath ?? (await this.findChrome());
    if (!chromePath) {
      throw new Error(
        "Chrome/Chromium not found. Please specify --chrome-path.",
      );
    }

    await this.close();

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
        "--headless=new",
      ],
      { stdio: ["ignore", "pipe", "pipe"], detached: false },
    );

    let spawnError: Error | null = null;
    this.chromeProcess.on("error", (err: Error) => {
      spawnError = err;
    });

    let page: Page | null = null;

    const tempOutputPath = this.createTempOutputPath(outputPath);
    let uploadServer: UploadServerResult | null = null;

    try {
      await this.waitForCdp(this.cdpPort);

      if (spawnError) {
        throw spawnError;
      }

      this.browser = await chromium.connectOverCDP(
        `http://127.0.0.1:${this.cdpPort}`,
        { noDefaults: true },
      );

      const contexts = this.browser.contexts();
      const context = contexts[0]!;
      page = await context.newPage();

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

      const saveTimeoutMs = options?.saveTimeoutMs ?? 120_000;
      const uploadTimeoutMs = options?.uploadTimeoutMs ?? 120_000;

      uploadServer = await this.createUploadServer(tempOutputPath, uploadTimeoutMs);

      const uploadResult = await viewerFrame.evaluate(
        async (params: {
          searchifyOk: boolean;
          uploadUrl: string;
          saveTimeoutMs: number;
        }): Promise<BrowserUploadResult> => {
          const viewer = (globalThis as Record<string, unknown>)["viewer"];
          if (!viewer || typeof viewer !== "object") {
            return { uploaded: false, reason: "NO_VIEWER" };
          }

          const ctrl = (viewer as Record<string, unknown>)["currentController"];
          if (!ctrl || typeof ctrl !== "object") {
            return { uploaded: false, reason: "NO_CONTROLLER" };
          }

          const ctrlObj = ctrl as Record<string, unknown>;
          const origHandle = (ctrlObj["handlePluginMessage_"] as Function).bind(ctrl);
          ctrlObj["handlePluginMessage_"] = function (msg: unknown) {
            return (origHandle as Function)(msg);
          };

          try {
            const saveType = params.searchifyOk ? "SEARCHIFIED" : "ORIGINAL";
            const result = await Promise.race([
              (ctrlObj["save"] as Function).call(ctrl, saveType),
              new Promise<null>((resolve) =>
                setTimeout(() => resolve(null), params.saveTimeoutMs),
              ),
            ]);

            if (result && (result as Record<string, unknown>)["dataToSave"]) {
              const r = result as { dataToSave: ArrayBuffer; fileName: string };
              const blob = new Blob([r.dataToSave], { type: "application/pdf" });
              const response = await fetch(params.uploadUrl, {
                method: "POST",
                headers: { "content-type": "application/pdf" },
                body: blob,
              });

              if (!response.ok) {
                return { uploaded: false, reason: "UPLOAD_FAILED", status: response.status };
              }

              return {
                uploaded: true,
                fileName: r.fileName,
                byteLength: r.dataToSave.byteLength,
                saveType,
              };
            }

            if (saveType === "SEARCHIFIED") {
              const originalResult = await Promise.race([
                (ctrlObj["save"] as Function).call(ctrl, "ORIGINAL"),
                new Promise<null>((resolve) =>
                  setTimeout(() => resolve(null), params.saveTimeoutMs),
                ),
              ]);
              if (originalResult && (originalResult as Record<string, unknown>)["dataToSave"]) {
                const or = originalResult as { dataToSave: ArrayBuffer; fileName: string };
                const blob = new Blob([or.dataToSave], { type: "application/pdf" });
                const response = await fetch(params.uploadUrl, {
                  method: "POST",
                  headers: { "content-type": "application/pdf" },
                  body: blob,
                });

                if (!response.ok) {
                  return { uploaded: false, reason: "UPLOAD_FAILED", status: response.status };
                }

                return {
                  uploaded: true,
                  fileName: or.fileName,
                  byteLength: or.dataToSave.byteLength,
                  saveType: "ORIGINAL",
                };
              }
            }
          } catch {
            // save failed
          }

          return { uploaded: false, reason: "NO_DATA" };
        },
        {
          searchifyOk: searchifyReady,
          uploadUrl: uploadServer.url,
          saveTimeoutMs,
        },
      );

      await page.close();
      page = null;

      if (uploadResult.uploaded) {
        await uploadServer.done;
        const tempStats = await stat(tempOutputPath);
        if (tempStats.size === 0) {
          throw new Error("Upload completed but output file is empty");
        }

        if (options?.verbose) {
          console.error(
            `[ChromeSearchifyPrinter] Received ${tempStats.size} bytes via upload`,
          );
        }

        await rename(tempOutputPath, outputPath);
      } else {
        if (options?.verbose) {
          console.error(
            `[ChromeSearchifyPrinter] Save returned no data (${uploadResult.reason}), copying original file`,
          );
        }
        await copyFile(inputPath, tempOutputPath);
        await rename(tempOutputPath, outputPath);
      }
    } catch (error) {
      if (page) {
        await page.close().catch(() => {});
      }
      if (uploadServer) {
        await uploadServer.close().catch(() => {});
      }
      await unlink(tempOutputPath).catch(() => {});
      await this.close();
      throw error;
    }
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

  private createTempOutputPath(outputPath: string): string {
    return join(
      dirname(outputPath),
      `.${basename(outputPath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`,
    );
  }

  private async createUploadServer(
    tempOutputPath: string,
    timeoutMs: number,
  ): Promise<UploadServerResult> {
    const token = randomUUID();
    let resolveDone: (bytes: number) => void;
    let rejectDone: (error: Error) => void;
    const done = new Promise<number>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

      if (req.method !== "POST" || url.pathname !== "/upload" || url.searchParams.get("token") !== token) {
        res.writeHead(403, { "Access-Control-Allow-Origin": "*" });
        res.end("Forbidden");
        return;
      }

      const ws = createWriteStream(tempOutputPath);
      let bytesWritten = 0;

      req.on("data", (chunk: Buffer) => {
        bytesWritten += chunk.length;
      });

      ws.on("error", (err: Error) => {
        res.writeHead(500, { "Access-Control-Allow-Origin": "*" });
        res.end("Write error");
        rejectDone(err);
      });

      req.pipe(ws);

      ws.on("finish", () => {
        res.writeHead(200, {
          "Access-Control-Allow-Origin": "*",
          "Content-Type": "text/plain",
        });
        res.end("OK");
        resolveDone(bytesWritten);
      });

      req.on("error", (err: Error) => {
        ws.destroy();
        unlink(tempOutputPath).catch(() => {});
        res.writeHead(500, { "Access-Control-Allow-Origin": "*" });
        res.end("Request error");
        rejectDone(err);
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });

    const address = server.address() as { port: number };
    const url = `http://127.0.0.1:${address.port}/upload?token=${token}`;

    const timeoutId = setTimeout(() => {
      rejectDone(new Error(`Upload timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    done.finally(() => clearTimeout(timeoutId));

    const close = async (): Promise<void> => {
      clearTimeout(timeoutId);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    };

    return { url, done, close };
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

type UploadServerResult = {
  url: string;
  done: Promise<number>;
  close: () => Promise<void>;
};
