import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    copyFile: vi.fn(),
    cp: vi.fn(),
    mkdtemp: vi.fn(),
    readFile: vi.fn(),
    rename: vi.fn(),
    rm: vi.fn(),
    stat: vi.fn(),
    unlink: vi.fn(),
    writeFile: vi.fn(),
  };
});

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

vi.mock("playwright-core", () => ({
  chromium: {
    connectOverCDP: vi.fn(),
  },
}));

vi.mock("../utils/upload-server.js", () => ({
  createUploadServer: vi.fn(),
}));

vi.mock("../utils/pdf-info.js", () => ({
  verifyPerPageText: vi.fn(),
}));

import { spawn } from "node:child_process";
import { createUploadServer } from "../utils/upload-server.js";
import { verifyPerPageText } from "../utils/pdf-info.js";
import { copyFile, cp, mkdtemp, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { chromium } from "playwright-core";
import { createCanvas } from "canvas";
import { PDFDocument } from "pdf-lib";
import { ChromeSearchifyPrinter } from "./chrome-searchify-printer.js";
import { saveAndUpload } from "./viewer-save-ops.js";
import type { OcrVerificationResult } from "../types/index.js";

type MockViewerFrame = {
  evaluate: ReturnType<typeof vi.fn>;
  scrolledPages: number[];
};

type MockPage = {
  goto: ReturnType<typeof vi.fn>;
  waitForTimeout: ReturnType<typeof vi.fn>;
  frames: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

type MockBrowser = {
  contexts: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

function createChromeProcess(): { on: ReturnType<typeof vi.fn>; stderr: { on: ReturnType<typeof vi.fn> }; stdout: { on: ReturnType<typeof vi.fn> }; kill: ReturnType<typeof vi.fn> } {
  return {
    on: vi.fn(),
    stderr: { on: vi.fn() },
    stdout: { on: vi.fn() },
    kill: vi.fn(),
  };
}

type ViewerSimulationOptions = {
  pageCount?: number;
  ocrTriggeredAfterSetup?: boolean;
  saveMock?: ReturnType<typeof vi.fn>;
  uploadMock?: ReturnType<typeof vi.fn>;
};

const DEFAULT_VERIFICATION: OcrVerificationResult = {
  totalPages: 3,
  ocrTargetPages: 3,
  verifiedPages: 3,
};

function createSimulatedViewerFrame(
  options?: ViewerSimulationOptions,
): MockViewerFrame & { scrolledPages: number[] } {
  const pageCount = options?.pageCount ?? 3;
  const ocrTriggeredAfterSetup = options?.ocrTriggeredAfterSetup ?? true;

  const saveMock =
    options?.saveMock ??
    vi.fn().mockResolvedValue({
      dataToSave: new Uint8Array([1, 2, 3]).buffer,
      fileName: "saved.pdf",
    });

  const uploadMock =
    options?.uploadMock ?? vi.fn().mockResolvedValue({ ok: true } as Response);

  const scrolledPages: number[] = [];

  const frame: MockViewerFrame & { scrolledPages: number[] } = {
    scrolledPages,
    evaluate: vi.fn().mockImplementation(async (fn: unknown, params?: unknown) => {
      if (typeof fn !== "function") return undefined;

      if (fn === saveAndUpload) {
        const g = globalThis as Record<string, unknown>;
        const prevViewer = g["viewer"];
        const prevFetch = globalThis.fetch;

        try {
          g["viewer"] = {
            currentController: {
              handlePluginMessage_: vi.fn(),
              save: saveMock,
            },
          };
          vi.spyOn(globalThis, "fetch").mockImplementation(uploadMock);
          return await (fn as (p: unknown) => Promise<unknown>)(params);
        } finally {
          g["viewer"] = prevViewer;
          globalThis.fetch = prevFetch;
        }
      }

      const fnString = fn.toString();

      if (
        fnString.includes("__searchifyProgress") &&
        fnString.includes("handlePluginMessage_") &&
        fnString.includes("pageCount") &&
        !fnString.includes("goToPage")
      ) {
        return { pageCount };
      }

      if (
        fnString.includes("goToPage") &&
        fnString.includes("viewport_") &&
        !fnString.includes("__searchifyProgress")
      ) {
        const pageIndex = params as number;
        scrolledPages.push(pageIndex);
        return undefined;
      }

      if (
        fnString.includes("__searchifyProgress") &&
        fnString.includes("ocrTriggered") &&
        !fnString.includes("handlePluginMessage_")
      ) {
        return { ocrTriggered: ocrTriggeredAfterSetup };
      }

      if (fnString.includes("viewer") && fnString.includes("currentController") && !fnString.includes("__searchifyProgress")) {
        return true;
      }

      if (fnString.includes("__searchifyProgress") && fnString.includes("pageCount")) {
        return {
          pageCount,
          ocrTriggered: ocrTriggeredAfterSetup,
        };
      }

      return undefined;
    }),
  };

  return frame;
}

function createPage(viewerFrame?: MockViewerFrame): { page: MockPage; frame: MockViewerFrame } {
  const frame = viewerFrame ?? createSimulatedViewerFrame();

  const page: MockPage = {
    goto: vi.fn().mockResolvedValue(undefined),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    frames: vi.fn().mockReturnValue([{}, frame]),
    close: vi.fn().mockResolvedValue(undefined),
  };

  return { page, frame };
}

function createBrowser(page: MockPage): { browser: MockBrowser; context: { newPage: ReturnType<typeof vi.fn> } } {
  const context = {
    newPage: vi.fn().mockResolvedValue(page),
  };

  const browser: MockBrowser = {
    contexts: vi.fn().mockReturnValue([context]),
    close: vi.fn().mockResolvedValue(undefined),
  };

  return { browser, context };
}

function mockProfile(profileDir = "/tmp/chromium-ocr-test-profile"): void {
  vi.mocked(mkdtemp).mockResolvedValue(profileDir);
  vi.mocked(cp).mockResolvedValue(undefined);
  vi.mocked(rm).mockResolvedValue(undefined);
  vi.mocked(rename).mockResolvedValue(undefined);
  vi.mocked(unlink).mockResolvedValue(undefined);
  vi.mocked(copyFile).mockResolvedValue(undefined);
  vi.mocked(stat).mockResolvedValue({ size: 1234 } as never);
  vi.mocked(readFile).mockResolvedValue(Buffer.from("fake pdf content"));
  vi.mocked(writeFile).mockResolvedValue(undefined);
}

type LocalRetryAccess = {
  attemptLocalRetry(
    inputPath: string,
    outputPath: string,
    failedIndices: number[],
    options?: Parameters<ChromeSearchifyPrinter["searchifyToFile"]>[2],
  ): Promise<OcrVerificationResult | null>;
  searchifyToFileInternal(
    inputPath: string,
    outputPath: string,
    options: Parameters<ChromeSearchifyPrinter["searchifyToFile"]>[2],
    allowLocalRetry: boolean,
  ): Promise<OcrVerificationResult>;
};

async function createThreePageRescueFixture(): Promise<{
  input: Buffer;
  output: Buffer;
  rescueOutput: Buffer;
}> {
  const canvas = createCanvas(8, 8);
  const context = canvas.getContext("2d");
  context.fillStyle = "#111";
  context.fillRect(0, 0, 8, 8);
  const jpeg = canvas.toBuffer("image/jpeg");

  const inputDoc = await PDFDocument.create();
  inputDoc.addPage([300, 400]);
  inputDoc.addPage([310, 410]);
  const jpegPage = inputDoc.addPage([320, 420]);
  const image = await inputDoc.embedJpg(jpeg);
  jpegPage.drawImage(image, { x: 0, y: 0, width: 320, height: 420 });

  const outputDoc = await PDFDocument.create();
  outputDoc.addPage([300, 400]);
  outputDoc.addPage([310, 410]);
  outputDoc.addPage([320, 420]);

  const rescueOutputDoc = await PDFDocument.create();
  rescueOutputDoc.addPage([595, 842]);

  return {
    input: Buffer.from(await inputDoc.save({ useObjectStreams: false })),
    output: Buffer.from(await outputDoc.save({ useObjectStreams: false })),
    rescueOutput: Buffer.from(await rescueOutputDoc.save({ useObjectStreams: false })),
  };
}

function mockChromeFound(): void {
  vi.mocked(stat).mockResolvedValue({} as never);
}

function mockChromeNotFound(): void {
  vi.mocked(stat).mockRejectedValue(new Error("not found"));
}

function mockFetchHealthy(): void {
  vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true } as Response);
}

function mockUploadServer(): void {
  vi.mocked(createUploadServer).mockResolvedValue({
    url: "http://127.0.0.1:54321/upload?token=test-token",
    done: Promise.resolve(1234),
    close: vi.fn().mockResolvedValue(undefined),
  });
}

function mockSearchifyRuntime(options?: {
  chromePath?: string;
  viewerFrame?: MockViewerFrame;
  page?: MockPage;
  browser?: MockBrowser;
  chromeProcess?: ReturnType<typeof createChromeProcess>;
  verification?: OcrVerificationResult;
}): { chromeProcess: ReturnType<typeof createChromeProcess>; page: MockPage; frame: MockViewerFrame; browser: MockBrowser } {
  mockProfile();
  mockFetchHealthy();
  mockUploadServer();

  vi.mocked(verifyPerPageText).mockReturnValue(
    options?.verification ?? DEFAULT_VERIFICATION,
  );

  if (!options?.chromePath) {
    mockChromeFound();
  }

  const chromeProcess = options?.chromeProcess ?? createChromeProcess();
  vi.mocked(spawn).mockReturnValue(chromeProcess as never);

  const pageBundle = options?.page
    ? { page: options.page, frame: options.viewerFrame }
    : createPage(options?.viewerFrame);

  const browserBundle = options?.browser
    ? { browser: options.browser }
    : createBrowser(pageBundle.page);

  vi.mocked(chromium.connectOverCDP).mockResolvedValue(
    browserBundle.browser as never,
  );

  return {
    chromeProcess,
    page: pageBundle.page,
    frame: pageBundle.frame,
    browser: browserBundle.browser,
  };
}

describe("ChromeSearchifyPrinter", () => {
  let printer: ChromeSearchifyPrinter;

  async function advanceUntilSettled(
    promise: Promise<unknown>,
    maxMs = 30_000,
    stepMs = 200,
  ): Promise<void> {
    let settled = false;
    promise.then(
      () => { settled = true; },
      () => { settled = true; },
    );

    for (let elapsed = 0; elapsed < maxMs && !settled; elapsed += stepMs) {
      await vi.advanceTimersByTimeAsync(stepMs);
    }

    expect(settled, `promise did not settle within ${maxMs}ms`).toBe(true);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    printer = new ChromeSearchifyPrinter();
  });

  afterEach(async () => {
    try {
      await printer.close();
    } catch {
      // ignore
    }

    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("spawns Chrome with required PDFSearchify flags", async () => {
    mockSearchifyRuntime({ chromePath: "/custom/chrome" });

    await printer.searchifyToFile("/tmp/input.pdf", "/tmp/output.pdf", {
      chromePath: "/custom/chrome",
    });

    expect(spawn).toHaveBeenCalledWith(
      "/custom/chrome",
      expect.arrayContaining([
        expect.stringMatching(/^--remote-debugging-port=\d+$/),
        "--remote-debugging-address=127.0.0.1",
        expect.stringMatching(/^--user-data-dir=\/tmp\/chromium-ocr-test-profile$/),
        "--no-first-run",
        "--no-default-browser-check",
        "--enable-features=PdfSearchify,PdfSearchifySave",
        "--disable-gpu",
        "--headless=new",
      ]),
      { stdio: ["ignore", "pipe", "pipe"], detached: true },
    );
  });

  it("uses provided chromePath instead of auto-discovery", async () => {
    mockSearchifyRuntime({ chromePath: "/provided/chrome" });

    await printer.searchifyToFile("/tmp/input.pdf", "/tmp/output.pdf", {
      chromePath: "/provided/chrome",
    });

    expect(spawn).toHaveBeenCalledWith(
      "/provided/chrome",
      expect.any(Array),
      expect.any(Object),
    );
  });

  it("throws clear error when Chrome cannot be found", async () => {
    mockChromeNotFound();

    await expect(
      printer.searchifyToFile("/tmp/input.pdf", "/tmp/output.pdf"),
    ).rejects.toThrow(
      "Chrome/Chromium not found. Please specify --chrome-path.",
    );

    expect(spawn).not.toHaveBeenCalled();
  });

  it("finds Chrome from default platform paths when chromePath is not provided", async () => {
    mockProfile();
    mockFetchHealthy();
    mockUploadServer();
    vi.mocked(verifyPerPageText).mockReturnValue(DEFAULT_VERIFICATION);

    const platformChromePaths: Record<string, string[]> = {
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

    const paths = platformChromePaths[process.platform] ?? [];
    expect(
      paths.length,
      `no known Chrome paths for platform=${process.platform}`,
    ).toBeGreaterThanOrEqual(2);

    vi.mocked(stat)
      .mockRejectedValueOnce(new Error("missing"))
      .mockResolvedValueOnce({} as never);

    const chromeProcess = createChromeProcess();
    vi.mocked(spawn).mockReturnValue(chromeProcess as never);

    const { page } = createPage();
    const { browser } = createBrowser(page);
    vi.mocked(chromium.connectOverCDP).mockResolvedValue(browser as never);

    await printer.searchifyToFile("/tmp/input.pdf", "/tmp/output.pdf");

    expect(stat).toHaveBeenNthCalledWith(1, paths[0]);
    expect(stat).toHaveBeenNthCalledWith(2, paths[1]);
    expect(spawn).toHaveBeenCalledWith(
      paths[1],
      expect.any(Array),
      expect.any(Object),
    );
  });

  it("copies Screen AI assets during profile setup", async () => {
    const originalHome = process.env.HOME;
    process.env.HOME = "/Users/tester";

    try {
      mockSearchifyRuntime({ chromePath: "/custom/chrome" });

      await printer.searchifyToFile("/tmp/input.pdf", "/tmp/output.pdf", {
        chromePath: "/custom/chrome",
      });

      expect(cp).toHaveBeenCalledWith(
        "/Users/tester/Library/Application Support/Google/Chrome/screen_ai",
        "/tmp/chromium-ocr-test-profile/screen_ai",
        { recursive: true },
      );
      expect(cp).toHaveBeenCalledWith(
        "/Users/tester/Library/Application Support/Google/Chrome/Local State",
        "/tmp/chromium-ocr-test-profile/Local State",
      );
    } finally {
      process.env.HOME = originalHome;
    }
  });

  it("connects to CDP after fetch reports healthy", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue({ ok: true } as Response);

    mockProfile();
    mockUploadServer();
    vi.mocked(verifyPerPageText).mockReturnValue(DEFAULT_VERIFICATION);
    const chromeProcess = createChromeProcess();
    vi.mocked(spawn).mockReturnValue(chromeProcess as never);

    const { page } = createPage();
    const { browser } = createBrowser(page);
    vi.mocked(chromium.connectOverCDP).mockResolvedValue(browser as never);

    await printer.searchifyToFile("/tmp/input.pdf", "/tmp/output.pdf", {
      chromePath: "/custom/chrome",
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/json\/version$/),
    );
    expect(chromium.connectOverCDP).toHaveBeenCalledWith(
      expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/),
      { noDefaults: true },
    );
  });

  it("spawns Chrome with --headless=new to suppress download UI", async () => {
    mockSearchifyRuntime({ chromePath: "/custom/chrome" });

    await printer.searchifyToFile("/tmp/input.pdf", "/tmp/output.pdf", {
      chromePath: "/custom/chrome",
    });

    expect(spawn).toHaveBeenCalledWith(
      "/custom/chrome",
      expect.arrayContaining(["--headless=new"]),
      expect.any(Object),
    );
  });

  it("rejects when CDP never becomes healthy and cleans up", async () => {
    vi.useFakeTimers();

    mockProfile();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("not ready"));

    const chromeProcess = createChromeProcess();
    vi.mocked(spawn).mockReturnValue(chromeProcess as never);

    const promise = printer.searchifyToFile("/tmp/input.pdf", "/tmp/output.pdf", {
      chromePath: "/custom/chrome",
    });
    promise.catch(() => {});

    await advanceUntilSettled(promise, 15_000);

    const diagnostics = (): string =>
      JSON.stringify({
        spawnCalls: vi.mocked(spawn).mock.calls.length,
        fetchCallCount: fetchSpy.mock.calls.length,
        killCalls: chromeProcess.kill.mock.calls.length,
        rmCalls: vi.mocked(rm).mock.calls.length,
      });

    await expect(promise).rejects.toThrow("Chrome CDP connection timed out");
    expect(chromeProcess.kill, diagnostics()).toHaveBeenCalled();
    expect(rm, diagnostics()).toHaveBeenCalledWith(
      "/tmp/chromium-ocr-test-profile",
      {
        recursive: true,
        force: true,
      },
    );
  });

  it("throws when PDF viewer frame is missing and cleans up resources", async () => {
    vi.useFakeTimers();

    const pageBundle = createPage();
    pageBundle.page.frames.mockReturnValue([{}]);

    const { chromeProcess } = mockSearchifyRuntime({
      chromePath: "/custom/chrome",
      page: pageBundle.page,
    });

    const promise = printer.searchifyToFile("/tmp/input.pdf", "/tmp/output.pdf", { chromePath: "/custom/chrome" });
    promise.catch(() => {});

    await advanceUntilSettled(promise, 30_000);

    await expect(promise).rejects.toThrow("PDF viewer frame not found within 15 seconds");

    expect(pageBundle.page.close).toHaveBeenCalled();
    expect(chromeProcess.kill).toHaveBeenCalled();
    expect(rm).toHaveBeenCalledWith("/tmp/chromium-ocr-test-profile", {
      recursive: true,
      force: true,
    });
  });

  it("throws save error when upload returns no data", async () => {
    const frame = createSimulatedViewerFrame({
      saveMock: vi.fn().mockResolvedValue(null),
    });
    const { chromeProcess } = mockSearchifyRuntime({ chromePath: "/custom/chrome", viewerFrame: frame });

    await expect(
      printer.searchifyToFile("/tmp/input.pdf", "/tmp/output.pdf", {
        chromePath: "/custom/chrome",
      }),
    ).rejects.toThrow("Save failed");

    expect(copyFile).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
    expect(chromeProcess.kill).toHaveBeenCalled();
  });

  it("verbose mode logs diagnostic messages", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockSearchifyRuntime({ chromePath: "/custom/chrome" });

    await printer.searchifyToFile("/tmp/input.pdf", "/tmp/output.pdf", {
      chromePath: "/custom/chrome",
      verbose: true,
    });

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("[ChromeSearchifyPrinter] Launching Chrome"),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("[ChromeSearchifyPrinter] Viewer ready"),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("[ChromeSearchifyPrinter] Pages:"),
    );
  });

  it("close() is idempotent and safe to call twice", async () => {
    const { chromeProcess } = mockSearchifyRuntime({
      chromePath: "/custom/chrome",
    });

    await printer.searchifyToFile("/tmp/input.pdf", "/tmp/output.pdf", {
      chromePath: "/custom/chrome",
    });

    await printer.close();
    await printer.close();

    expect(chromeProcess.kill).toHaveBeenCalledTimes(1);
    expect(rm).toHaveBeenCalledTimes(1);
  });

  it("close() propagates rm() failures, ignoring browser.close() errors", async () => {
    const { page } = createPage();
    const { browser } = createBrowser(page);
    browser.close.mockRejectedValue(new Error("browser close failed"));

    mockProfile();
    mockUploadServer();
    vi.mocked(verifyPerPageText).mockReturnValue(DEFAULT_VERIFICATION);
    vi.mocked(rm).mockRejectedValue(new Error("rm failed"));
    mockFetchHealthy();

    const chromeProcess = createChromeProcess();
    vi.mocked(spawn).mockReturnValue(chromeProcess as never);
    vi.mocked(chromium.connectOverCDP).mockResolvedValue(browser as never);

    await printer.searchifyToFile("/tmp/input.pdf", "/tmp/output.pdf", {
      chromePath: "/custom/chrome",
    });

    await expect(printer.close()).rejects.toThrow("rm failed");
  });

  it("searchifyToFile cleans up resources when connectOverCDP fails", async () => {
    mockProfile();
    mockFetchHealthy();

    const chromeProcess = createChromeProcess();
    vi.mocked(spawn).mockReturnValue(chromeProcess as never);
    vi.mocked(chromium.connectOverCDP).mockRejectedValue(
      new Error("CDP connect failed"),
    );

    await expect(
      printer.searchifyToFile("/tmp/input.pdf", "/tmp/output.pdf", { chromePath: "/custom/chrome" }),
    ).rejects.toThrow("CDP connect failed");

    expect(chromeProcess.kill).toHaveBeenCalled();
    expect(rm).toHaveBeenCalledWith("/tmp/chromium-ocr-test-profile", {
      recursive: true,
      force: true,
    });
  });

  it("searchifyToFile cleans up resources when page.goto fails", async () => {
    const pageBundle = createPage();
    pageBundle.page.goto.mockRejectedValue(new Error("goto failed"));

    const chromeProcess = createChromeProcess();
    mockSearchifyRuntime({
      chromePath: "/custom/chrome",
      page: pageBundle.page,
      chromeProcess,
    });

    await expect(
      printer.searchifyToFile("/tmp/input.pdf", "/tmp/output.pdf", { chromePath: "/custom/chrome" }),
    ).rejects.toThrow("goto failed");

    expect(chromeProcess.kill).toHaveBeenCalled();
    expect(rm).toHaveBeenCalledWith("/tmp/chromium-ocr-test-profile", {
      recursive: true,
      force: true,
    });
  });

  it("executes saveAndUpload with SEARCHIFIED when OCR succeeds", async () => {
    const saveMock = vi.fn().mockResolvedValue({
      dataToSave: new Uint8Array([1, 2, 3]).buffer,
      fileName: "saved.pdf",
    });
    const uploadMock = vi.fn().mockResolvedValue({ ok: true } as Response);

    const viewerFrame = createSimulatedViewerFrame({
      saveMock,
      uploadMock,
    });

    mockSearchifyRuntime({ chromePath: "/custom/chrome", viewerFrame });

    const result = await printer.searchifyToFile("/tmp/input.pdf", "/tmp/output.pdf", {
      chromePath: "/custom/chrome",
    });

    expect(saveMock).toHaveBeenCalledWith("SEARCHIFIED");
    expect(saveMock).toHaveBeenCalledTimes(1);
    expect(uploadMock).toHaveBeenCalled();
    expect(rename).toHaveBeenCalledTimes(1);
    expect(result).toEqual(DEFAULT_VERIFICATION);
  });

  it("throws when pageCount is 0", async () => {
    const saveMock = vi.fn().mockResolvedValue({
      dataToSave: new Uint8Array([1, 2, 3]).buffer,
      fileName: "original.pdf",
    });

    const viewerFrame = createSimulatedViewerFrame({
      pageCount: 0,
      saveMock,
    });

    const { chromeProcess } = mockSearchifyRuntime({ chromePath: "/custom/chrome", viewerFrame });

    await expect(
      printer.searchifyToFile("/tmp/input.pdf", "/tmp/output.pdf", {
        chromePath: "/custom/chrome",
      }),
    ).rejects.toThrow("PDF has no pages to process");

    expect(copyFile).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
    expect(chromeProcess.kill).toHaveBeenCalled();
  });

  it("delegates to createUploadServer with temp output path", async () => {
    mockSearchifyRuntime({ chromePath: "/custom/chrome" });

    await printer.searchifyToFile("/tmp/input.pdf", "/tmp/output.pdf", {
      chromePath: "/custom/chrome",
      uploadTimeoutMs: 4567,
    });

    expect(createUploadServer).toHaveBeenCalledWith(
      expect.stringContaining(".output.pdf."),
      4567,
    );
  });

  it("propagates browser upload fetch failures instead of falling back to NO_DATA", async () => {
    const saveMock = vi.fn().mockResolvedValue({
      dataToSave: new Uint8Array([1, 2, 3]).buffer,
      fileName: "saved.pdf",
    });
    const uploadMock = vi.fn().mockRejectedValue(
      new TypeError("Failed to fetch"),
    );

    const viewerFrame = createSimulatedViewerFrame({ saveMock, uploadMock });

    const { chromeProcess } = mockSearchifyRuntime({
      chromePath: "/custom/chrome",
      viewerFrame,
    });

    await expect(
      printer.searchifyToFile("/tmp/input.pdf", "/tmp/output.pdf", {
        chromePath: "/custom/chrome",
      }),
    ).rejects.toThrow("Failed to fetch");

    expect(copyFile).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
    expect(chromeProcess.kill).toHaveBeenCalled();
  });

  it("throws save error when SEARCHIFIED save returns null", async () => {
    const saveMock = vi.fn().mockResolvedValue(null);

    const viewerFrame = createSimulatedViewerFrame({ saveMock });

    const { chromeProcess } = mockSearchifyRuntime({
      chromePath: "/custom/chrome",
      viewerFrame,
    });

    await expect(
      printer.searchifyToFile("/tmp/input.pdf", "/tmp/output.pdf", {
        chromePath: "/custom/chrome",
      }),
    ).rejects.toThrow("Save failed (NO_DATA)");

    expect(saveMock).toHaveBeenCalledWith("SEARCHIFIED");
    expect(saveMock).toHaveBeenCalledTimes(1);
    expect(copyFile).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
    expect(chromeProcess.kill).toHaveBeenCalled();
  });

  it("propagates upload server close failure after successful upload", async () => {
    const saveMock = vi.fn().mockResolvedValue({
      dataToSave: new Uint8Array([1, 2, 3]).buffer,
      fileName: "saved.pdf",
    });
    const uploadMock = vi.fn().mockResolvedValue({ ok: true } as Response);

    const viewerFrame = createSimulatedViewerFrame({ saveMock, uploadMock });

    const uploadServerClose = vi
      .fn()
      .mockRejectedValue(new Error("upload server close failed"));

    mockProfile();
    mockFetchHealthy();
    vi.mocked(verifyPerPageText).mockReturnValue(DEFAULT_VERIFICATION);
    vi.mocked(createUploadServer).mockResolvedValue({
      url: "http://127.0.0.1:54321/upload?token=test-token",
      done: Promise.resolve(1234),
      close: uploadServerClose,
    });

    const chromeProcess = createChromeProcess();
    vi.mocked(spawn).mockReturnValue(chromeProcess as never);
    const { page } = createPage(viewerFrame);
    const { browser } = createBrowser(page);
    vi.mocked(chromium.connectOverCDP).mockResolvedValue(browser as never);

    await expect(
      printer.searchifyToFile("/tmp/input.pdf", "/tmp/output.pdf", {
        chromePath: "/custom/chrome",
      }),
    ).rejects.toThrow("upload server close failed");

    expect(uploadServerClose).toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
  });

  it("throws when upload succeeds but output file is empty", async () => {
    const saveMock = vi.fn().mockResolvedValue({
      dataToSave: new Uint8Array([1, 2, 3]).buffer,
      fileName: "saved.pdf",
    });
    const uploadMock = vi.fn().mockResolvedValue({ ok: true } as Response);

    const viewerFrame = createSimulatedViewerFrame({ saveMock, uploadMock });
    const { chromeProcess } = mockSearchifyRuntime({
      chromePath: "/custom/chrome",
      viewerFrame,
    });

    vi.mocked(stat).mockResolvedValue({ size: 0 } as never);

    await expect(
      printer.searchifyToFile("/tmp/input.pdf", "/tmp/output.pdf", {
        chromePath: "/custom/chrome",
      }),
    ).rejects.toThrow("Upload completed but output file is empty");

    expect(rename).not.toHaveBeenCalled();
    expect(chromeProcess.kill).toHaveBeenCalled();
  });

  it("preserves primary error when cleanup also fails", async () => {
    const pageBundle = createPage();
    pageBundle.page.goto.mockRejectedValue(new Error("goto failed"));
    pageBundle.page.close.mockRejectedValue(new Error("page close failed"));

    mockProfile();
    const uploadServerClose = vi
      .fn()
      .mockRejectedValue(new Error("upload server close failed"));
    vi.mocked(createUploadServer).mockResolvedValue({
      url: "http://127.0.0.1:54321/upload?token=test-token",
      done: Promise.resolve(1234),
      close: uploadServerClose,
    });
    vi.mocked(unlink).mockRejectedValue(new Error("unlink failed"));
    mockFetchHealthy();

    const chromeProcess = createChromeProcess();
    vi.mocked(spawn).mockReturnValue(chromeProcess as never);
    const { browser } = createBrowser(pageBundle.page);
    browser.close.mockRejectedValue(new Error("browser close failed"));
    vi.mocked(rm).mockRejectedValue(new Error("rm failed"));
    vi.mocked(chromium.connectOverCDP).mockResolvedValue(browser as never);

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      printer.searchifyToFile("/tmp/input.pdf", "/tmp/output.pdf", {
        chromePath: "/custom/chrome",
      }),
    ).rejects.toThrow("goto failed");

    expect(pageBundle.page.close).toHaveBeenCalled();
    expect(uploadServerClose).not.toHaveBeenCalled();
    expect(unlink).toHaveBeenCalled();
    expect(chromeProcess.kill).toHaveBeenCalled();

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("page close failed"),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("unlink failed"),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("close() failed during error cleanup"),
    );
  });

  it("close() skips browser.close() after process kill to avoid hangs", async () => {
    const { page } = createPage();
    const { browser } = createBrowser(page);
    browser.close.mockReturnValue(new Promise(() => {}));

    mockProfile();
    mockUploadServer();
    mockFetchHealthy();
    vi.mocked(verifyPerPageText).mockReturnValue(DEFAULT_VERIFICATION);

    const chromeProcess = createChromeProcess();
    vi.mocked(spawn).mockReturnValue(chromeProcess as never);
    vi.mocked(chromium.connectOverCDP).mockResolvedValue(browser as never);

    await printer.searchifyToFile("/tmp/input.pdf", "/tmp/output.pdf", {
      chromePath: "/custom/chrome",
    });

    await expect(printer.close()).resolves.toBeUndefined();
    expect(browser.close).not.toHaveBeenCalled();
  });

  it("logs optional Screen AI profile copy failures in verbose mode", async () => {
    const originalHome = process.env.HOME;
    process.env.HOME = "/Users/tester";

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    mockFetchHealthy();
    mockUploadServer();

    const chromeProcess = createChromeProcess();
    vi.mocked(spawn).mockReturnValue(chromeProcess as never);
    const { page } = createPage();
    const { browser } = createBrowser(page);
    vi.mocked(chromium.connectOverCDP).mockResolvedValue(browser as never);

    vi.mocked(cp).mockImplementation(async (src: string) => {
      if (typeof src === "string" && src.includes("screen_ai")) {
        throw new Error("screen_ai not found");
      }
      if (typeof src === "string" && src.includes("Local State")) {
        throw new Error("Local State not found");
      }
      return undefined;
    });
    vi.mocked(mkdtemp).mockResolvedValue("/tmp/chromium-ocr-test-profile");
    vi.mocked(stat).mockResolvedValue({} as never);
    vi.mocked(readFile).mockResolvedValue(Buffer.from("fake pdf content"));
    vi.mocked(verifyPerPageText).mockReturnValue(DEFAULT_VERIFICATION);

    await printer.searchifyToFile("/tmp/input.pdf", "/tmp/output.pdf", {
      chromePath: "/custom/chrome",
      verbose: true,
    });

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Optional profile asset copy failed"),
    );

    process.env.HOME = originalHome;
  });

  it("returns OcrVerificationResult from searchifyToFile", async () => {
    const customVerification: OcrVerificationResult = {
      totalPages: 5,
      ocrTargetPages: 4,
      verifiedPages: 4,
    };
    mockSearchifyRuntime({ chromePath: "/custom/chrome", verification: customVerification });

    const result = await printer.searchifyToFile("/tmp/input.pdf", "/tmp/output.pdf", {
      chromePath: "/custom/chrome",
    });

    expect(result).toEqual(customVerification);
  });

  it("calls verifyPerPageText on output file after save", async () => {
    mockSearchifyRuntime({ chromePath: "/custom/chrome" });

    await printer.searchifyToFile("/tmp/input.pdf", "/tmp/output.pdf", {
      chromePath: "/custom/chrome",
    });

    expect(readFile).toHaveBeenCalledWith("/tmp/output.pdf");
    expect(verifyPerPageText).toHaveBeenCalledWith(
      expect.any(Buffer),
    );
  });

  it("verbose log includes ocrTriggered status", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const frame = createSimulatedViewerFrame({
      pageCount: 5,
      ocrTriggeredAfterSetup: false,
    });
    mockSearchifyRuntime({ chromePath: "/custom/chrome", viewerFrame: frame });

    await printer.searchifyToFile("/tmp/input.pdf", "/tmp/output.pdf", {
      chromePath: "/custom/chrome",
      verbose: true,
    });

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Pages: 5, ocrTriggered: false"),
    );
  });

  it("proceeds to save regardless of ocrTriggered value", async () => {
    const saveMock = vi.fn().mockResolvedValue({
      dataToSave: new Uint8Array([1, 2, 3]).buffer,
      fileName: "saved.pdf",
    });

    const frame = createSimulatedViewerFrame({
      ocrTriggeredAfterSetup: false,
      saveMock,
    });
    mockSearchifyRuntime({ chromePath: "/custom/chrome", viewerFrame: frame });

    const result = await printer.searchifyToFile("/tmp/input.pdf", "/tmp/output.pdf", {
      chromePath: "/custom/chrome",
    });

    expect(saveMock).toHaveBeenCalledWith("SEARCHIFIED");
    expect(result).toEqual(DEFAULT_VERIFICATION);
    expect(rename).toHaveBeenCalledTimes(1);
  });

  it("logs verbose when viewer frame not ready on first attempt", async () => {
    vi.useFakeTimers();

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    let viewerReadyCallCount = 0;
    const baseFrame = createSimulatedViewerFrame();
    const frame: MockViewerFrame = {
      evaluate: vi.fn().mockImplementation(async (fn: unknown, params?: unknown) => {
        if (typeof fn !== "function") return undefined;
        const fnString = fn.toString();

        if (fnString.includes("viewer") && fnString.includes("currentController") && !fnString.includes("__searchifyProgress") && !fnString.includes("saveTimeoutMs")) {
          viewerReadyCallCount++;
          if (viewerReadyCallCount === 1) throw new Error("frame not ready");
          return true;
        }

        return baseFrame.evaluate(fn, params);
      }),
    };

    const { page } = createPage(frame);
    mockSearchifyRuntime({ chromePath: "/custom/chrome", viewerFrame: frame, page });

    const promise = printer.searchifyToFile("/tmp/input.pdf", "/tmp/output.pdf", {
      chromePath: "/custom/chrome",
      verbose: true,
    });
    promise.catch(() => {});

    await advanceUntilSettled(promise, 10_000);

    await expect(promise).resolves.toEqual(DEFAULT_VERIFICATION);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Found 2 frames, waiting for viewer"),
    );
  });

  describe("OCR progress callback", () => {
    it("emits document-completed during successful OCR", async () => {
      const onOcrProgress = vi.fn();
      mockSearchifyRuntime({ chromePath: "/custom/chrome" });

      const result = await printer.searchifyToFile("/tmp/input.pdf", "/tmp/output.pdf", {
        chromePath: "/custom/chrome",
        onOcrProgress,
      });

      expect(result).toEqual(DEFAULT_VERIFICATION);
      expect(onOcrProgress).toHaveBeenCalledWith(
        expect.objectContaining({ type: "document-completed", pageCount: 3, elapsedMs: expect.any(Number) }),
      );
    });

    it("emits document-completed with pageCount from viewer", async () => {
      const onOcrProgress = vi.fn();
      const frame = createSimulatedViewerFrame({ pageCount: 7 });
      mockSearchifyRuntime({ chromePath: "/custom/chrome", viewerFrame: frame });

      await printer.searchifyToFile("/tmp/input.pdf", "/tmp/output.pdf", {
        chromePath: "/custom/chrome",
        onOcrProgress,
      });

      expect(onOcrProgress).toHaveBeenCalledWith(
        expect.objectContaining({ type: "document-completed", pageCount: 7 }),
      );
    });

    it("does not emit events when pageCount is 0", async () => {
      const onOcrProgress = vi.fn();
      const frame = createSimulatedViewerFrame({
        pageCount: 0,
      });

      mockSearchifyRuntime({ chromePath: "/custom/chrome", viewerFrame: frame });

      await expect(
        printer.searchifyToFile("/tmp/input.pdf", "/tmp/output.pdf", {
          chromePath: "/custom/chrome",
          onOcrProgress,
        }),
      ).rejects.toThrow("PDF has no pages to process");

      expect(onOcrProgress).not.toHaveBeenCalled();
    });

    it("propagates error when progress callback throws", async () => {
      const onOcrProgress = vi.fn().mockImplementation((event) => {
        if (event.type === "document-completed") {
          throw new Error("callback exploded");
        }
      });

      mockSearchifyRuntime({ chromePath: "/custom/chrome" });

      await expect(
        printer.searchifyToFile("/tmp/input.pdf", "/tmp/output.pdf", {
          chromePath: "/custom/chrome",
          onOcrProgress,
        }),
      ).rejects.toThrow("callback exploded");
    });

    it("emits page-scrolled for each page in order", async () => {
      const onOcrProgress = vi.fn();
      mockSearchifyRuntime({ chromePath: "/custom/chrome" });

      await printer.searchifyToFile("/tmp/input.pdf", "/tmp/output.pdf", {
        chromePath: "/custom/chrome",
        onOcrProgress,
      });

      const scrollEvents = onOcrProgress.mock.calls
        .map((call) => call[0])
        .filter((e) => e.type === "page-scrolled");

      expect(scrollEvents).toEqual([
        { type: "page-scrolled", pageIndex: 0, pageCount: 3 },
        { type: "page-scrolled", pageIndex: 1, pageCount: 3 },
        { type: "page-scrolled", pageIndex: 2, pageCount: 3 },
      ]);
    });

    it("emits ocr-waiting before post-scroll buffer", async () => {
      const onOcrProgress = vi.fn();
      mockSearchifyRuntime({ chromePath: "/custom/chrome" });

      await printer.searchifyToFile("/tmp/input.pdf", "/tmp/output.pdf", {
        chromePath: "/custom/chrome",
        onOcrProgress,
      });

      expect(onOcrProgress).toHaveBeenCalledWith(
        expect.objectContaining({ type: "ocr-waiting", pageCount: 3, waitMs: 900 }),
      );
    });

    it("scrolls all pages in order via evaluate", async () => {
      const frame = createSimulatedViewerFrame({ pageCount: 5 });
      mockSearchifyRuntime({ chromePath: "/custom/chrome", viewerFrame: frame });

      await printer.searchifyToFile("/tmp/input.pdf", "/tmp/output.pdf", {
        chromePath: "/custom/chrome",
      });

      expect(frame.scrolledPages).toEqual([0, 1, 2, 3, 4]);
    });
  });

  describe("OCR recovery strategy", () => {
    const PARTIAL_VERIFICATION: OcrVerificationResult = {
      totalPages: 3,
      ocrTargetPages: 3,
      verifiedPages: 1,
      pageStatuses: ["text", "image_without_text", "text"],
    };

    it("does not retry when all pages verified on first attempt", async () => {
      mockSearchifyRuntime({ chromePath: "/custom/chrome" });

      await printer.searchifyToFile("/tmp/input.pdf", "/tmp/output.pdf", {
        chromePath: "/custom/chrome",
      });

      expect(vi.mocked(verifyPerPageText)).toHaveBeenCalledTimes(1);
    });

    it("resolves temporal failure with single re-scroll retry", async () => {
      mockSearchifyRuntime({ chromePath: "/custom/chrome" });
      vi.mocked(verifyPerPageText)
        .mockReturnValueOnce(PARTIAL_VERIFICATION)
        .mockReturnValueOnce(DEFAULT_VERIFICATION);

      const result = await printer.searchifyToFile("/tmp/input.pdf", "/tmp/output.pdf", {
        chromePath: "/custom/chrome",
      });

      expect(result).toEqual(DEFAULT_VERIFICATION);
      expect(result.failedPageIndices ?? []).toEqual([]);
      expect(vi.mocked(verifyPerPageText)).toHaveBeenCalledTimes(2);
    }, 30_000);

    it("does at most 1 re-scroll retry before giving up (no blind looping)", async () => {
      mockSearchifyRuntime({ chromePath: "/custom/chrome" });
      vi.mocked(verifyPerPageText).mockReturnValue(PARTIAL_VERIFICATION);

      await printer.searchifyToFile("/tmp/input.pdf", "/tmp/output.pdf", {
        chromePath: "/custom/chrome",
        maxRetries: 5,
      });

      // NOT 6 calls (maxRetries+1). At most 2: initial + 1 re-scroll.
      expect(vi.mocked(verifyPerPageText)).toHaveBeenCalledTimes(2);
    }, 30_000);

    it("allows maxRetries=0 to skip the temporal retry", async () => {
      mockSearchifyRuntime({ chromePath: "/custom/chrome" });
      vi.mocked(verifyPerPageText).mockReturnValue(PARTIAL_VERIFICATION);

      await printer.searchifyToFile("/tmp/input.pdf", "/tmp/output.pdf", {
        chromePath: "/custom/chrome",
        maxRetries: 0,
      });

      expect(vi.mocked(verifyPerPageText)).toHaveBeenCalledTimes(1);
    });

    it("emits ocr-retry progress event before re-scroll", async () => {
      const onOcrProgress = vi.fn();
      mockSearchifyRuntime({ chromePath: "/custom/chrome" });
      vi.mocked(verifyPerPageText)
        .mockReturnValueOnce(PARTIAL_VERIFICATION)
        .mockReturnValueOnce(DEFAULT_VERIFICATION);

      await printer.searchifyToFile("/tmp/input.pdf", "/tmp/output.pdf", {
        chromePath: "/custom/chrome",
        onOcrProgress,
      });

      expect(onOcrProgress).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "ocr-retry",
          attempt: 1,
        }),
      );
    }, 30_000);

    it("populates failedPageIndices when all recovery fails", async () => {
      mockSearchifyRuntime({ chromePath: "/custom/chrome" });
      vi.mocked(verifyPerPageText).mockReturnValue(PARTIAL_VERIFICATION);

      const result = await printer.searchifyToFile("/tmp/input.pdf", "/tmp/output.pdf", {
        chromePath: "/custom/chrome",
      });

      expect(result.failedPageIndices).toBeDefined();
      expect(result.failedPageIndices).toEqual([1]);
      expect(result.verifiedPages).toBe(1);
    }, 30_000);

    it("page is closed after recovery completes", async () => {
      const { page } = mockSearchifyRuntime({ chromePath: "/custom/chrome" });
      vi.mocked(verifyPerPageText)
        .mockReturnValueOnce(PARTIAL_VERIFICATION)
        .mockReturnValueOnce(DEFAULT_VERIFICATION);

      await printer.searchifyToFile("/tmp/input.pdf", "/tmp/output.pdf", {
        chromePath: "/custom/chrome",
      });

      expect(page.close).toHaveBeenCalledTimes(1);
    }, 30_000);

    it("runs one non-recursive local OCR pass and merges only mapped rescue pages", async () => {
      mockProfile("/tmp/chromium-ocr-rescue-test");
      const fixture = await createThreePageRescueFixture();
      vi.mocked(readFile).mockImplementation(async (path) => {
        const value = String(path);
        if (value === "/tmp/input.pdf") return fixture.input;
        if (value === "/tmp/output.pdf") return fixture.output;
        if (value.endsWith("/rescue-output.pdf")) return fixture.rescueOutput;
        throw new Error(`Unexpected read: ${value}`);
      });

      const localRetry = printer as unknown as LocalRetryAccess;
      const internalSpy = vi
        .spyOn(localRetry, "searchifyToFileInternal")
        .mockResolvedValue({
          totalPages: 1,
          ocrTargetPages: 1,
          verifiedPages: 1,
          pageStatuses: ["text"],
        });
      const finalVerification: OcrVerificationResult = {
        totalPages: 3,
        ocrTargetPages: 3,
        verifiedPages: 2,
        pageStatuses: ["text", "image_without_text", "text"],
      };
      vi.mocked(verifyPerPageText)
        .mockReturnValueOnce({
          totalPages: 1,
          ocrTargetPages: 1,
          verifiedPages: 1,
          pageStatuses: ["text"],
        })
        .mockReturnValueOnce(finalVerification);

      const result = await localRetry.attemptLocalRetry(
        "/tmp/input.pdf",
        "/tmp/output.pdf",
        [1, 2],
      );

      expect(internalSpy).toHaveBeenCalledTimes(1);
      expect(internalSpy).toHaveBeenCalledWith(
        expect.stringMatching(/rescue-input\.pdf$/),
        expect.stringMatching(/rescue-output\.pdf$/),
        undefined,
        false,
      );
      expect(result).toEqual(finalVerification);

      const outputWrite = vi.mocked(writeFile).mock.calls.find(
        ([path]) => String(path) === "/tmp/output.pdf",
      );
      expect(outputWrite).toBeDefined();
      const merged = await PDFDocument.load(outputWrite![1] as Uint8Array);
      expect(merged.getPageCount()).toBe(3);
      expect(merged.getPage(1).getSize()).toEqual({ width: 310, height: 410 });
      expect(merged.getPage(2).getSize()).toEqual({ width: 595, height: 842 });
    });

    it("does not launch local OCR when failed pages have no extractable JPEG", async () => {
      mockProfile("/tmp/chromium-ocr-rescue-test");
      const fixture = await createThreePageRescueFixture();
      vi.mocked(readFile).mockResolvedValue(fixture.input);

      const localRetry = printer as unknown as LocalRetryAccess;
      const internalSpy = vi.spyOn(localRetry, "searchifyToFileInternal");

      const result = await localRetry.attemptLocalRetry(
        "/tmp/input.pdf",
        "/tmp/output.pdf",
        [1],
      );

      expect(result).toBeNull();
      expect(internalSpy).not.toHaveBeenCalled();
      expect(writeFile).not.toHaveBeenCalled();
    });

    it("keeps the existing page when local OCR does not verify the rescue page", async () => {
      mockProfile("/tmp/chromium-ocr-rescue-test");
      const fixture = await createThreePageRescueFixture();
      vi.mocked(readFile).mockImplementation(async (path) => {
        const value = String(path);
        if (value === "/tmp/input.pdf") return fixture.input;
        if (value === "/tmp/output.pdf") return fixture.output;
        if (value.endsWith("/rescue-output.pdf")) return fixture.rescueOutput;
        throw new Error(`Unexpected read: ${value}`);
      });

      const localRetry = printer as unknown as LocalRetryAccess;
      vi.spyOn(localRetry, "searchifyToFileInternal").mockResolvedValue({
        totalPages: 1,
        ocrTargetPages: 1,
        verifiedPages: 1,
        pageStatuses: ["text"],
      });
      vi.mocked(verifyPerPageText)
        .mockReturnValueOnce({
          totalPages: 1,
          ocrTargetPages: 1,
          verifiedPages: 0,
          pageStatuses: ["image_without_text"],
        })
        .mockReturnValueOnce({
          totalPages: 3,
          ocrTargetPages: 3,
          verifiedPages: 2,
          pageStatuses: ["text", "text", "image_without_text"],
        });

      await localRetry.attemptLocalRetry(
        "/tmp/input.pdf",
        "/tmp/output.pdf",
        [2],
      );

      const outputWrite = vi.mocked(writeFile).mock.calls.find(
        ([path]) => String(path) === "/tmp/output.pdf",
      );
      expect(outputWrite).toBeDefined();
      const merged = await PDFDocument.load(outputWrite![1] as Uint8Array);
      expect(merged.getPage(2).getSize()).toEqual({ width: 320, height: 420 });
    });
  });
});
