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
import type { IChromeSearchifyPrinter, SearchifyToFileOptions, OcrProgressCallback, OcrVerificationResult } from "../types/index.js";
import {
  createUploadServer,
  type UploadServerResult,
} from "../utils/upload-server.js";
import { saveAndUpload } from "./viewer-save-ops.js";
import { verifyPerPageText } from "../utils/pdf-info.js";

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
  ): Promise<OcrVerificationResult> {
    const chunkSize = options?.chunkSize ?? 50;
    if (chunkSize > 0) {
      try {
        const { readFile } = await import("node:fs/promises");
        const { PDFDocument } = await import("pdf-lib");
        const inputBuf = await readFile(inputPath);
        const srcDoc = await PDFDocument.load(inputBuf, { ignoreEncryption: true });
        const docPageCount = srcDoc.getPageCount();
        if (docPageCount > chunkSize) {
          return this.searchifyChunked(srcDoc, outputPath, options, docPageCount, chunkSize);
        }
      } catch {
        // File not readable or parseable; proceed with normal single-file processing
      }
    }

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

      const { pageCount } = await this.waitForSearchifyComplete(viewerFrame, {
        verbose: options?.verbose,
        onOcrProgress: options?.onOcrProgress,
      });

      const saveTimeoutMs = options?.saveTimeoutMs ?? 120_000;
      const uploadTimeoutMs = options?.uploadTimeoutMs ?? 120_000;
      const maxRetries = options?.maxRetries ?? 5;
      const onOcrProgress = options?.onOcrProgress;

      let verification: OcrVerificationResult | null = null;

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (attempt > 0) {
          if (options?.verbose) {
            console.error(
              `[ChromeSearchifyPrinter] Retry ${attempt}/${maxRetries}: ${verification!.verifiedPages}/${verification!.totalPages} pages verified`,
            );
          }

          onOcrProgress?.({
            type: "ocr-retry",
            attempt,
            maxRetries,
            verifiedPages: verification!.verifiedPages,
            totalPages: verification!.totalPages,
          });

         const failedPageIndices = this.extractFailedPageIndices(verification!);

         if (failedPageIndices.length > 0) {
           if (options?.verbose) {
             console.error(
               `[ChromeSearchifyPrinter] Targeted re-scroll: ${failedPageIndices.length} unverified pages (indices ${failedPageIndices.slice(0, 10).join(",")}${failedPageIndices.length > 10 ? "..." : ""})`,
             );
           }
           await this.scrollSpecificPagesInViewer(
             viewerFrame,
             failedPageIndices,
             onOcrProgress,
             pageCount,
             1000,
           );

          const waitMs = Math.max(failedPageIndices.length * 1000, 10_000);
           onOcrProgress?.({ type: "ocr-waiting", pageCount: failedPageIndices.length, waitMs });
           await new Promise((r) => setTimeout(r, waitMs));
        } else {
          await this.scrollPagesInViewer(viewerFrame, pageCount, onOcrProgress);
          const waitMs = pageCount * 100;
           onOcrProgress?.({ type: "ocr-waiting", pageCount, waitMs });
           await new Promise((r) => setTimeout(r, waitMs));
         }
        }

        uploadServer = await createUploadServer(tempOutputPath, uploadTimeoutMs);

        const uploadResult = await viewerFrame.evaluate(
          saveAndUpload,
          {
            uploadUrl: uploadServer.url,
            saveTimeoutMs,
          },
        );

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

          await uploadServer.close();
          uploadServer = null;

          await rename(tempOutputPath, outputPath);

          const { readFile } = await import("node:fs/promises");
          const outputBuffer = await readFile(outputPath);
          verification = verifyPerPageText(outputBuffer);

          if (options?.verbose) {
            console.error(
              `[ChromeSearchifyPrinter] Verification: ${verification.verifiedPages}/${verification.ocrTargetPages} pages verified`,
            );
          }

          if (verification.verifiedPages >= verification.ocrTargetPages) {
            break;
          }
        } else {
          throw new Error(
            `Save failed (${uploadResult.reason})`,
          );
        }
      }

      await page.close();
      page = null;

      return verification!;
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
      onOcrProgress?: OcrProgressCallback;
    },
  ): Promise<{ pageCount: number }> {
    const verbose = options?.verbose;
    const onOcrProgress = options?.onOcrProgress;

    const setupResult = await viewerFrame.evaluate(
      /* v8 ignore start -- browser-side callback; not executed in Node.js unit tests */
      (): Promise<{
        pageCount: number;
      }> => {
      const g = globalThis as Record<string, unknown>;
      const viewer = g["viewer"] as Record<string, unknown> | undefined;
      if (!viewer)
        return Promise.resolve({ pageCount: 0 });

      const ctrl = viewer["currentController"] as Record<string, unknown> | undefined;
      if (!ctrl)
        return Promise.resolve({ pageCount: 0 });

      const progress: Record<string, boolean> = { ocrTriggered: false };
      g["__searchifyProgress"] = progress;

      const origHandle = (ctrl["handlePluginMessage_"] as Function).bind(ctrl);
      ctrl["handlePluginMessage_"] = function (msg: unknown) {
        const msgData = (msg as { data?: Record<string, unknown> })?.data;
        if (msgData?.["type"] === "setHasSearchifyText") {
          progress.ocrTriggered = true;
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

      return Promise.resolve({ pageCount });
    });
    /* v8 ignore end */

    const { pageCount } = setupResult;

    if (pageCount === 0) {
      throw new Error("PDF has no pages to process");
    }

    await this.scrollPagesInViewer(viewerFrame, pageCount, onOcrProgress);

    const waitMs = pageCount * 300;

    onOcrProgress?.({ type: "ocr-waiting", pageCount, waitMs });

    await new Promise((r) => setTimeout(r, waitMs));

    const statusResult = await viewerFrame.evaluate(
      /* v8 ignore start -- browser-side callback; not executed in Node.js unit tests */
      (): { ocrTriggered: boolean } => {
        const g = globalThis as Record<string, unknown>;
        const progress = g["__searchifyProgress"] as Record<string, boolean> | undefined;
        return { ocrTriggered: progress?.["ocrTriggered"] ?? false };
      },
      /* v8 ignore end */
    );

    const { ocrTriggered } = statusResult;

    if (verbose) {
      console.error(
        `[ChromeSearchifyPrinter] Pages: ${pageCount}, ocrTriggered: ${ocrTriggered}`,
      );
    }

    if (onOcrProgress) {
      onOcrProgress({ type: "document-completed", pageCount, elapsedMs: 0 });
    }

    return { pageCount };
  }

  private async scrollPagesInViewer(
    viewerFrame: Frame,
    pageCount: number,
    onOcrProgress?: OcrProgressCallback,
  ): Promise<void> {
    await this.scrollSpecificPagesInViewer(
      viewerFrame,
      Array.from({ length: pageCount }, (_, i) => i),
      onOcrProgress,
      pageCount,
      300,
    );
  }

  private extractFailedPageIndices(
    verification: OcrVerificationResult,
  ): number[] {
    const statuses = verification.pageStatuses;
    if (!statuses || statuses.length === 0) return [];
    const failed: number[] = [];
    for (let i = 0; i < statuses.length; i++) {
      const status = statuses[i]!;
      if (status === "image_without_text" || status === "unresolved") {
        failed.push(i);
      }
    }
    return failed;
  }

  private async scrollSpecificPagesInViewer(
    viewerFrame: Frame,
    pageIndices: number[],
    onOcrProgress?: OcrProgressCallback,
    pageCount?: number,
    delayMs = 300,
  ): Promise<void> {
    for (const pageIndex of pageIndices) {
      await viewerFrame.evaluate(
        /* v8 ignore start -- browser-side callback; not executed in Node.js unit tests */
        (pageIndex: number) => {
          const g = globalThis as Record<string, unknown>;
          const viewer = g["viewer"] as Record<string, unknown> | undefined;
          if (!viewer) return;
          const viewport = viewer["viewport_"] as Record<string, unknown> | undefined;
          if (viewport && typeof viewport["goToPage"] === "function") {
            (viewport["goToPage"] as Function).call(viewport, pageIndex);
          }
        },
        /* v8 ignore end */
        pageIndex,
      );

      onOcrProgress?.({ type: "page-scrolled", pageIndex, pageCount: pageCount ?? pageIndices.length });

     await new Promise((r) => setTimeout(r, delayMs));
   }
 }

  private async searchifyChunked(
    srcDoc: import("pdf-lib").PDFDocument,
    outputPath: string,
    options: SearchifyToFileOptions | undefined,
    pageCount: number,
    chunkSize: number,
  ): Promise<OcrVerificationResult> {
    const { PDFDocument } = await import("pdf-lib");
    const { readFile, writeFile } = await import("node:fs/promises");
    const tmpDir = await mkdtemp(join(tmpdir(), "chromium-ocr-chunks-"));

    try {
      const chunkCount = Math.ceil(pageCount / chunkSize);
      const chunkOutputPaths: string[] = [];

      for (let c = 0; c < chunkCount; c++) {
        const startPage = c * chunkSize;
        const endPage = Math.min(startPage + chunkSize, pageCount);

        if (options?.verbose) {
          console.error(
            `[ChromeSearchifyPrinter] Chunk ${c + 1}/${chunkCount}: pages ${startPage}-${endPage - 1}`,
          );
        }

        const chunkDoc = await PDFDocument.create();
        const pageIndices = Array.from(
          { length: endPage - startPage },
          (_, j) => startPage + j,
        );
        const pages = await chunkDoc.copyPages(srcDoc, pageIndices);
        pages.forEach((p) => chunkDoc.addPage(p));
        const chunkBytes = Buffer.from(await chunkDoc.save({ useObjectStreams: false }));

        const chunkInputPath = join(tmpDir, `chunk-${c}-input.pdf`);
        const chunkOutputPath = join(tmpDir, `chunk-${c}-output.pdf`);
        await writeFile(chunkInputPath, chunkBytes);
        chunkOutputPaths.push(chunkOutputPath);

        const chunkOptions: SearchifyToFileOptions = {
          ...options,
          chunkSize: undefined,
        };

        const chunkResult = await this.searchifyToFile(
          chunkInputPath,
          chunkOutputPath,
          chunkOptions,
        );

        if (options?.verbose) {
          console.error(
            `[ChromeSearchifyPrinter] Chunk ${c + 1} result: ${chunkResult.verifiedPages}/${chunkResult.ocrTargetPages} verified`,
          );
        }

        this.close().catch(() => {});
      }

      if (options?.verbose) {
        console.error(`[ChromeSearchifyPrinter] Merging ${chunkOutputPaths.length} chunks...`);
      }

      const mergedDoc = await PDFDocument.create();
      for (const chunkPath of chunkOutputPaths) {
        const chunkBuf = await readFile(chunkPath);
        const chunkDoc = await PDFDocument.load(chunkBuf, { ignoreEncryption: true });
        const pages = await mergedDoc.copyPages(chunkDoc, chunkDoc.getPageIndices());
        pages.forEach((p) => mergedDoc.addPage(p));
      }
      const mergedBytes = Buffer.from(await mergedDoc.save({ useObjectStreams: false }));

      await writeFile(outputPath, mergedBytes);

      let finalVerification = verifyPerPageText(mergedBytes);

      if (
        finalVerification.verifiedPages < finalVerification.ocrTargetPages &&
        finalVerification.pageStatuses
      ) {
        const failedIndices = finalVerification.pageStatuses
          .map((s, i) => ({ index: i, status: s }))
          .filter((p) => p.status === "image_without_text" || p.status === "unresolved")
          .map((p) => p.index);

        if (failedIndices.length > 0 && failedIndices.length <= 20) {
          if (options?.verbose) {
            console.error(
              `[ChromeSearchifyPrinter] Rescue pass: re-processing ${failedIndices.length} failed pages at enlarged size`,
            );
          }

          const rescueDoc = await PDFDocument.create();
          for (const idx of failedIndices) {
            const singlePageDoc = await PDFDocument.create();
            const [singlePage] = await singlePageDoc.copyPages(srcDoc, [idx]);
            singlePageDoc.addPage(singlePage);
            const singlePageBytes = Buffer.from(
              await singlePageDoc.save({ useObjectStreams: false }),
            );
            const singlePageText = singlePageBytes.toString("latin1");
            const dctIdx = singlePageText.indexOf("/DCTDecode");
            if (dctIdx < 0) continue;
            const streamMarker = singlePageText.indexOf("stream", dctIdx);
            const streamHeaderEnd = singlePageText.indexOf("\n", streamMarker) + 1;
            const dataEnd = singlePageText.indexOf("endstream", streamHeaderEnd);
            let actualEnd = dataEnd;
            while (actualEnd > streamHeaderEnd && (singlePageText[actualEnd - 1] === "\n" || singlePageText[actualEnd - 1] === "\r")) {
              actualEnd--;
            }
            const jpegData = Uint8Array.from(singlePageBytes.subarray(streamHeaderEnd, actualEnd));
            const img = await rescueDoc.embedJpg(jpegData);
            const rescuePage = rescueDoc.addPage([595, 842]);
            rescuePage.drawImage(img, {
              x: 0,
              y: 0,
              width: 595,
              height: 842,
            });
          }

          const rescueBytes = Buffer.from(await rescueDoc.save({ useObjectStreams: false }));
          const rescueInputPath = join(tmpDir, "rescue-input.pdf");
          const rescueOutputPath = join(tmpDir, "rescue-output.pdf");
          await writeFile(rescueInputPath, rescueBytes);

          const rescueResult = await this.searchifyToFile(
            rescueInputPath,
            rescueOutputPath,
            { ...options, chunkSize: undefined },
          );

          if (rescueResult.verifiedPages > 0) {
            const rescueBuf = await readFile(rescueOutputPath);
            const rescueDocOut = await PDFDocument.load(rescueBuf, { ignoreEncryption: true });
            const rescueVerification = verifyPerPageText(rescueBuf);

            if (rescueVerification.pageStatuses) {
              const finalDoc = await PDFDocument.create();
              let rescueIdx = 0;
              for (let i = 0; i < pageCount; i++) {
                const failedPos = failedIndices.indexOf(i);
                if (failedPos >= 0) {
                  const st = rescueVerification.pageStatuses[rescueIdx];
                  if (st === "text" || st === "blank") {
                    const [rescuedPage] = await finalDoc.copyPages(rescueDocOut, [rescueIdx]);
                    finalDoc.addPage(rescuedPage);
                  } else {
                    const [origPage] = await srcDoc.copyPages(srcDoc, [i]);
                    finalDoc.addPage(origPage);
                  }
                  rescueIdx++;
                } else {
                  const chunkIdx = Math.floor(i / chunkSize);
                  const pageInChunk = i % chunkSize;
                  const chunkBuf = await readFile(chunkOutputPaths[chunkIdx]!);
                  const chunkDoc = await PDFDocument.load(chunkBuf, { ignoreEncryption: true });
                  const [page] = await finalDoc.copyPages(chunkDoc, [pageInChunk]);
                  finalDoc.addPage(page);
                }
              }
              const finalBytes = Buffer.from(await finalDoc.save({ useObjectStreams: false }));
              await writeFile(outputPath, finalBytes);
              finalVerification = verifyPerPageText(finalBytes);
            }
          }

          this.close().catch(() => {});
        }
      }

      if (options?.verbose) {
        console.error(
          `[ChromeSearchifyPrinter] Merged result: ${finalVerification.verifiedPages}/${finalVerification.ocrTargetPages} verified`,
        );
      }

      return finalVerification;
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
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
