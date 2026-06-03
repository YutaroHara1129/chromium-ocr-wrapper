import { chromium } from "playwright-core";
import { spawn, type ChildProcess } from "node:child_process";
import {
  cp,
  mkdtemp,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import type { Browser, Frame, Page } from "playwright-core";
import type { IChromeSearchifyPrinter, SearchifyToFileOptions, OcrProgressCallback } from "../types/index.js";

const DEFAULT_OCR_BASE_TIMEOUT_MS = 30_000;
const DEFAULT_OCR_PER_PAGE_TIMEOUT_MS = 3_000;
import {
  createUploadServer,
  type UploadServerResult,
} from "../utils/upload-server.js";
import { saveAndUpload } from "./viewer-save-ops.js";

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

    this.profileDir = await this.setupProfile(options?.verbose);
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
      { stdio: ["ignore", "pipe", "pipe"], detached: true },
    );

    let spawnError: Error | null = null;
    this.chromeProcess.on("error", (err: Error) => {
      /* v8 ignore next -- spawn error handler; untestable with mocked spawn */
      spawnError = err;
    });

    let page: Page | null = null;

    const tempOutputPath = this.createTempOutputPath(outputPath);
    let uploadServer: UploadServerResult | null = null;

    try {
      await this.waitForCdp(this.cdpPort);

      /* v8 ignore start -- spawn error rethrow; unreachable with mocked spawn */
      if (spawnError) {
        throw spawnError;
      }
      /* v8 ignore end */

      this.browser = await chromium.connectOverCDP(
        `http://127.0.0.1:${this.cdpPort}`,
        { noDefaults: true },
      );

      const contexts = this.browser.contexts();
      const context = contexts[0]!;
      page = await context.newPage();

      const fileUrl = pathToFileURL(inputPath).href;
      await page.goto(fileUrl, { waitUntil: "load", timeout: 15_000 });

      const viewerFrame = await this.waitForViewerFrame(page, options?.verbose);

      const searchifyReady = await this.waitForSearchifyComplete(
        viewerFrame,
        {
          verbose: options?.verbose,
          ocrTimeoutMs: options?.ocrTimeoutMs,
          onOcrProgress: options?.onOcrProgress,
        },
      );

      if (!searchifyReady) {
        throw new Error("OCR did not produce searchable output");
      }

      const saveTimeoutMs = options?.saveTimeoutMs ?? 120_000;
      const uploadTimeoutMs = options?.uploadTimeoutMs ?? 120_000;

      uploadServer = await createUploadServer(tempOutputPath, uploadTimeoutMs);

      const uploadResult = await viewerFrame.evaluate(
        saveAndUpload,
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
            `[ChromeSearchifyPrinter] Received ${tempStats.size} bytes via upload (saveType=${uploadResult.saveType})`,
          );
        }

        await rename(tempOutputPath, outputPath);
      } else {
        throw new Error(
          `OCR did not produce searchable output (${uploadResult.reason})`,
        );
      }

      await uploadServer.close();
    } catch (error) {
      if (page) {
        try {
          await page.close();
        } catch (closeError) {
          const msg = closeError instanceof Error ? closeError.message : String(closeError);
          console.error(`[ChromeSearchifyPrinter] page.close() failed during error cleanup: ${msg}`);
        }
      }
      if (uploadServer) {
        try {
          await uploadServer.close();
        } catch (closeError) {
          const msg = closeError instanceof Error ? closeError.message : String(closeError);
          console.error(`[ChromeSearchifyPrinter] uploadServer.close() failed during error cleanup: ${msg}`);
        }
      }
      try {
        await unlink(tempOutputPath);
      } catch (unlinkError) {
        const code = (unlinkError as NodeJS.ErrnoException)?.code;
        if (code !== "ENOENT") {
          const msg = unlinkError instanceof Error ? unlinkError.message : String(unlinkError);
          console.error(`[ChromeSearchifyPrinter] unlink() failed during error cleanup: ${msg}`);
        }
      }
      try {
        await this.close();
      } catch (closeError) {
        const msg = closeError instanceof Error ? closeError.message : String(closeError);
        console.error(`[ChromeSearchifyPrinter] close() failed during error cleanup: ${msg}`);
      }
      throw error;
    }
  }

  async close(): Promise<void> {
    const errors: Error[] = [];

    const browser = this.browser;
    this.browser = null;

    const killed = this.killProcessGroup();

    if (browser && !killed) {
      try {
        await browser.close();
      } catch {
        // browser disconnected
      }
    }

    const profileDir = this.profileDir;
    this.profileDir = null;

    if (profileDir) {
      try {
        await rm(profileDir, { recursive: true, force: true });
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }

    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(
        errors,
        "ChromeSearchifyPrinter cleanup failed",
      );
    }
  }

  killProcessGroup(): boolean {
    if (this.chromeProcess) {
      try {
        process.kill(-this.chromeProcess.pid!, "SIGKILL");
      } catch {
        try {
          this.chromeProcess.kill("SIGKILL");
        } catch {
          // process already dead
        }
      }
      this.chromeProcess = null;
      return true;
    }
    return false;
  }

  private createTempOutputPath(outputPath: string): string {
    return join(
      dirname(outputPath),
      `.${basename(outputPath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`,
    );
  }

  private async waitForViewerFrame(
    page: Page,
    verbose?: boolean,
  ): Promise<Frame> {
    for (let attempt = 0; attempt < 30; attempt++) {
      const frames = page.frames();
      const viewerFrame = frames[1];
      if (viewerFrame) {
        try {
          const ready = await viewerFrame.evaluate(() => {
            /* v8 ignore start -- browser-side callback; not executed in Node.js unit tests */
            const v = (globalThis as Record<string, unknown>)["viewer"];
            if (!v || typeof v !== "object") return false;
            const ctrl = (v as Record<string, unknown>)["currentController"];
            if (!ctrl) return false;
            const vp = (v as Record<string, unknown>)["viewport_"] as Record<string, unknown> | undefined;
            if (!vp) return false;
            const pageDims = vp["pageDimensions_"] as Array<unknown> | undefined;
            return Array.isArray(pageDims) && pageDims.length > 0;
            /* v8 ignore end */
          });
          if (ready) {
            if (verbose) {
              console.error(
                `[ChromeSearchifyPrinter] Viewer ready after ${(attempt + 1) * 500}ms`,
              );
            }
            return viewerFrame;
          }
        } catch {
          // Frame not fully loaded yet
        }
      }
      if (verbose && attempt === 0) {
        console.error(
          `[ChromeSearchifyPrinter] Found ${frames.length} frames, waiting for viewer...`,
        );
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error("PDF viewer frame not found within 15 seconds");
  }

  private async waitForSearchifyComplete(
    viewerFrame: Frame,
    options?: {
      verbose?: boolean;
      ocrTimeoutMs?: number;
      onOcrProgress?: OcrProgressCallback;
    },
  ): Promise<boolean> {
    const verbose = options?.verbose;
    const onOcrProgress = options?.onOcrProgress;

    const setupResult = await viewerFrame.evaluate(
      /* v8 ignore start -- browser-side callback; not executed in Node.js unit tests */
      async (): Promise<{
        pageCount: number;
        doneAfterScroll: boolean;
      }> => {
      const g = globalThis as Record<string, unknown>;
      const viewer = g["viewer"] as Record<string, unknown> | undefined;
      if (!viewer)
        return { pageCount: 0, doneAfterScroll: false };

      const ctrl = viewer["currentController"] as Record<string, unknown> | undefined;
      if (!ctrl)
        return { pageCount: 0, doneAfterScroll: false };

      const progress: Record<string, boolean> = { done: false };
      g["__searchifyProgress"] = progress;

      const origHandle = (ctrl["handlePluginMessage_"] as Function).bind(ctrl);
      ctrl["handlePluginMessage_"] = function (msg: unknown) {
        const msgData = (msg as { data?: Record<string, unknown> })?.data;
        if (msgData?.["type"] === "setHasSearchifyText") {
          progress.done = true;
        }
        return (origHandle as Function)(msg);
      };

      const docLength = (viewer["docLength_"] as number | undefined) || 0;
      const docDimsNoUnder = viewer["documentDimensions"] as Record<string, unknown> | undefined;
      const docDimsPagesNoUnder = docDimsNoUnder
        ? (docDimsNoUnder["pageDimensions"] as Array<unknown> | undefined)?.length
        : undefined;
      const docDims = viewer["documentDimensions_"] as Record<string, unknown> | undefined;
      const docDimsPages = docDims
        ? (docDims["pageDimensions"] as Array<unknown> | undefined)?.length
        : undefined;
      const viewport = viewer["viewport_"] as Record<string, unknown> | undefined;
      const vpPageDims = viewport
        ? (viewport["pageDimensions_"] as Array<unknown> | undefined)
        : undefined;
      const viewportPages = vpPageDims?.length;
      const pageCount =
        docLength || docDimsPagesNoUnder || docDimsPages || viewportPages || 0;

      if (viewport && typeof viewport["goToPage"] === "function") {
        for (let i = 0; i < pageCount; i++) {
          (viewport["goToPage"] as Function).call(viewport, i);
          await new Promise((r) => setTimeout(r, 300));
        }
      }

      return { pageCount, doneAfterScroll: progress["done"] ?? false };
    });
    /* v8 ignore end */

    const { pageCount, doneAfterScroll } = setupResult;
    const startTime = Date.now();

    if (verbose) {
      console.error(
        `[ChromeSearchifyPrinter] Pages: ${pageCount}, doneAfterScroll: ${doneAfterScroll}`,
      );
    }

    if (pageCount === 0) return false;
    if (doneAfterScroll) {
      if (verbose) {
        console.error("[ChromeSearchifyPrinter] OCR already complete after scrolling");
      }
      onOcrProgress?.({ type: "document-completed", pageCount, elapsedMs: Date.now() - startTime });
      return true;
    }

    const ocrTimeoutMs = options?.ocrTimeoutMs ?? DEFAULT_OCR_BASE_TIMEOUT_MS + pageCount * DEFAULT_OCR_PER_PAGE_TIMEOUT_MS;
    const pollIntervalMs = 500;
    let pollCount = 0;

    while (Date.now() - startTime < ocrTimeoutMs) {
      const state = await viewerFrame.evaluate((): { done: boolean } => {
        /* v8 ignore start -- browser-side callback; not executed in Node.js unit tests */
        const g = globalThis as Record<string, unknown>;
        const p = g["__searchifyProgress"] as Record<string, boolean> | undefined;
        return { done: p?.["done"] ?? false };
        /* v8 ignore end */
      });

      if (state.done) {
        if (verbose) {
          console.error(
            `[ChromeSearchifyPrinter] OCR complete after ${Date.now() - startTime}ms`,
          );
        }
        onOcrProgress?.({ type: "document-completed", pageCount, elapsedMs: Date.now() - startTime });
        return true;
      }

      pollCount++;
      if (verbose && pollCount % 10 === 0) {
        console.error(
          `[ChromeSearchifyPrinter] Waiting for OCR... ${Date.now() - startTime}ms elapsed (done=${state.done})`,
        );
      }

      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }

    const elapsedMs = Date.now() - startTime;
    if (verbose) {
      console.error(
        `[ChromeSearchifyPrinter] OCR timed out after ${elapsedMs}ms (timeout: ${ocrTimeoutMs}ms)`,
      );
    }
    onOcrProgress?.({ type: "timeout", timeoutMs: ocrTimeoutMs, elapsedMs });
    throw new Error(`OCR timed out after ${elapsedMs}ms (timeout: ${ocrTimeoutMs}ms)`);
  }

  private async setupProfile(verbose?: boolean): Promise<string> {
    const profileDir = await mkdtemp(join(tmpdir(), "chromium-ocr-"));
    const homeDir = process.env.HOME ?? "";

    const screenAiSrc = `${homeDir}/Library/Application Support/Google/Chrome/screen_ai`;
    const localStateSrc = `${homeDir}/Library/Application Support/Google/Chrome/Local State`;

    await this.copyOptionalProfileAsset(
      screenAiSrc,
      `${profileDir}/screen_ai`,
      { recursive: true, verbose },
    );
    await this.copyOptionalProfileAsset(
      localStateSrc,
      `${profileDir}/Local State`,
      { verbose },
    );

    return profileDir;
  }

  private async copyOptionalProfileAsset(
    source: string,
    destination: string,
    options?: { recursive?: boolean; verbose?: boolean },
  ): Promise<void> {
    try {
      if (options?.recursive) {
        await cp(source, destination, { recursive: true });
      } else {
        await cp(source, destination);
      }
    } catch (error) {
      if (options?.verbose) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(
          `[ChromeSearchifyPrinter] Optional profile asset copy failed: ${source} -> ${destination}: ${message}`,
        );
      }
    }
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
