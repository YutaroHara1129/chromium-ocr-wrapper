import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    copyFile: vi.fn(),
    cp: vi.fn(),
    mkdtemp: vi.fn(),
    rename: vi.fn(),
    rm: vi.fn(),
    stat: vi.fn(),
    unlink: vi.fn(),
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

import { spawn } from "node:child_process";
import { createUploadServer } from "../utils/upload-server.js";
import { copyFile, cp, mkdtemp, rename, rm, stat, unlink } from "node:fs/promises";
import { chromium } from "playwright-core";
import { ChromeSearchifyPrinter } from "./chrome-searchify-printer.js";
import { saveAndUpload } from "./viewer-save-ops.js";

type MockViewerFrame = {
  evaluate: ReturnType<typeof vi.fn>;
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
  hasSearchifyText?: boolean;
  progressDoneAfterSetup?: boolean;
  saveMock?: ReturnType<typeof vi.fn>;
  uploadMock?: ReturnType<typeof vi.fn>;
  pollingStateFn?: (callCount: number) => {
    started: boolean;
    done: boolean;
    hasSearchifyText: boolean;
  };
};

function createSimulatedViewerFrame(
  options?: ViewerSimulationOptions,
): MockViewerFrame {
  const pageCount = options?.pageCount ?? 3;
  const hasSearchifyText = options?.hasSearchifyText ?? true;
  const progressDoneAfterSetup = options?.progressDoneAfterSetup ?? false;

  const saveMock =
    options?.saveMock ??
    vi.fn().mockResolvedValue({
      dataToSave: new Uint8Array([1, 2, 3]).buffer,
      fileName: "saved.pdf",
    });

  const uploadMock =
    options?.uploadMock ?? vi.fn().mockResolvedValue({ ok: true } as Response);

  let searchifySetupCall = 0;
  let pollingCallCount = 0;

  const frame: MockViewerFrame = {
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

      if (fnString.includes("viewer") && fnString.includes("currentController") && !fnString.includes("__searchifyProgress")) {
        return true;
      }

      if (fnString.includes("__searchifyProgress") && fnString.includes("pageCount")) {
        searchifySetupCall++;
        return {
          pageCount,
          initialHasSearchifyText: hasSearchifyText,
          doneAfterScroll: progressDoneAfterSetup || searchifySetupCall > 1,
        };
      }

      if (fnString.includes("__searchifyProgress") && fnString.includes("started")) {
        if (options?.pollingStateFn) {
          return options.pollingStateFn(++pollingCallCount);
        }
        return {
          started: true,
          done: true,
          hasSearchifyText,
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
}): { chromeProcess: ReturnType<typeof createChromeProcess>; page: MockPage; frame: MockViewerFrame; browser: MockBrowser } {
  mockProfile();
  mockFetchHealthy();
  mockUploadServer();

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

    const { chromeProcess, browser } = mockSearchifyRuntime({
      chromePath: "/custom/chrome",
      page: pageBundle.page,
    });

    const promise = printer.searchifyToFile("/tmp/input.pdf", "/tmp/output.pdf", { chromePath: "/custom/chrome" });
    promise.catch(() => {});

    await advanceUntilSettled(promise, 20_000);

    await expect(promise).rejects.toThrow("PDF viewer frame not found within 15 seconds");

    expect(pageBundle.page.close).toHaveBeenCalled();
    expect(browser.close).toHaveBeenCalled();
    expect(chromeProcess.kill).toHaveBeenCalled();
    expect(rm).toHaveBeenCalledWith("/tmp/chromium-ocr-test-profile", {
      recursive: true,
      force: true,
    });
  });

  it("renames temp file to output after fallback copy", async () => {
    const frame = createSimulatedViewerFrame({
      saveMock: vi.fn().mockResolvedValue(null),
    });
    mockSearchifyRuntime({ chromePath: "/custom/chrome", viewerFrame: frame });

    await printer.searchifyToFile("/tmp/input.pdf", "/tmp/output.pdf", {
      chromePath: "/custom/chrome",
    });

    expect(copyFile).toHaveBeenCalledWith(
      "/tmp/input.pdf",
      expect.stringContaining(".output.pdf."),
    );
    expect(rename).toHaveBeenCalledWith(
      expect.stringContaining(".output.pdf."),
      "/tmp/output.pdf",
    );
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
      expect.stringContaining("[ChromeSearchifyPrinter] OCR complete"),
    );
  });

  it("close() is idempotent and safe to call twice", async () => {
    const { chromeProcess, browser } = mockSearchifyRuntime({
      chromePath: "/custom/chrome",
    });

    await printer.searchifyToFile("/tmp/input.pdf", "/tmp/output.pdf", {
      chromePath: "/custom/chrome",
    });

    await printer.close();
    await printer.close();

    expect(browser.close).toHaveBeenCalledTimes(1);
    expect(chromeProcess.kill).toHaveBeenCalledTimes(1);
    expect(rm).toHaveBeenCalledTimes(1);
  });

  it("close() propagates browser.close() and rm() failures", async () => {
    const { page } = createPage();
    const { browser } = createBrowser(page);
    browser.close.mockRejectedValue(new Error("browser close failed"));

    mockProfile();
    mockUploadServer();
    vi.mocked(rm).mockRejectedValue(new Error("rm failed"));
    mockFetchHealthy();

    const chromeProcess = createChromeProcess();
    vi.mocked(spawn).mockReturnValue(chromeProcess as never);
    vi.mocked(chromium.connectOverCDP).mockResolvedValue(browser as never);

    await printer.searchifyToFile("/tmp/input.pdf", "/tmp/output.pdf", {
      chromePath: "/custom/chrome",
    });

    await expect(printer.close()).rejects.toSatisfy((err: unknown) => {
      if (!(err instanceof AggregateError)) return false;
      return err.errors.some((e) => e.message.includes("browser close failed"))
        && err.errors.some((e) => e.message.includes("rm failed"));
    });
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
    const { browser } = mockSearchifyRuntime({
      chromePath: "/custom/chrome",
      page: pageBundle.page,
      chromeProcess,
    });

    await expect(
      printer.searchifyToFile("/tmp/input.pdf", "/tmp/output.pdf", { chromePath: "/custom/chrome" }),
    ).rejects.toThrow("goto failed");

    expect(browser.close).toHaveBeenCalled();
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

    await printer.searchifyToFile("/tmp/input.pdf", "/tmp/output.pdf", {
      chromePath: "/custom/chrome",
    });

    expect(saveMock).toHaveBeenCalledWith("SEARCHIFIED");
    expect(uploadMock).toHaveBeenCalled();
    expect(rename).toHaveBeenCalledTimes(1);
  });

  it("executes saveAndUpload with ORIGINAL when OCR reports pageCount=0", async () => {
    const saveMock = vi.fn().mockResolvedValue({
      dataToSave: new Uint8Array([1, 2, 3]).buffer,
      fileName: "original.pdf",
    });
    const uploadMock = vi.fn().mockResolvedValue({ ok: true } as Response);

    const viewerFrame = createSimulatedViewerFrame({
      pageCount: 0,
      saveMock,
      uploadMock,
    });

    mockSearchifyRuntime({ chromePath: "/custom/chrome", viewerFrame });

    await printer.searchifyToFile("/tmp/input.pdf", "/tmp/output.pdf", {
      chromePath: "/custom/chrome",
    });

    expect(saveMock).toHaveBeenCalledWith("ORIGINAL");
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

    const { browser, chromeProcess } = mockSearchifyRuntime({
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
    expect(browser.close).toHaveBeenCalled();
    expect(chromeProcess.kill).toHaveBeenCalled();
  });

  it("propagates ORIGINAL path upload failures when SEARCHIFIED save returns null", async () => {
    const saveMock = vi.fn().mockImplementation((saveType: string) => {
      if (saveType === "SEARCHIFIED") return Promise.resolve(null);
      return Promise.resolve({
        dataToSave: new Uint8Array([1, 2, 3]).buffer,
        fileName: "original.pdf",
      });
    });
    const uploadMock = vi.fn().mockRejectedValue(
      new TypeError("NetworkError when attempting to fetch resource"),
    );

    const viewerFrame = createSimulatedViewerFrame({ saveMock, uploadMock });

    const { browser, chromeProcess } = mockSearchifyRuntime({
      chromePath: "/custom/chrome",
      viewerFrame,
    });

    await expect(
      printer.searchifyToFile("/tmp/input.pdf", "/tmp/output.pdf", {
        chromePath: "/custom/chrome",
      }),
    ).rejects.toThrow("NetworkError when attempting to fetch resource");

    expect(saveMock).toHaveBeenCalledWith("SEARCHIFIED");
    expect(saveMock).toHaveBeenCalledWith("ORIGINAL");
    expect(copyFile).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
    expect(browser.close).toHaveBeenCalled();
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
    expect(rename).toHaveBeenCalledTimes(1);
  });

  it("throws when upload succeeds but output file is empty", async () => {
    const saveMock = vi.fn().mockResolvedValue({
      dataToSave: new Uint8Array([1, 2, 3]).buffer,
      fileName: "saved.pdf",
    });
    const uploadMock = vi.fn().mockResolvedValue({ ok: true } as Response);

    const viewerFrame = createSimulatedViewerFrame({ saveMock, uploadMock });
    const { browser, chromeProcess } = mockSearchifyRuntime({
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
    expect(browser.close).toHaveBeenCalled();
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
    expect(browser.close).toHaveBeenCalled();
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

  it("close() rejects when browser.close() times out", async () => {
    const { page } = createPage();
    const { browser } = createBrowser(page);
    browser.close.mockReturnValue(new Promise(() => {}));

    mockProfile();
    mockUploadServer();
    mockFetchHealthy();

    const chromeProcess = createChromeProcess();
    vi.mocked(spawn).mockReturnValue(chromeProcess as never);
    vi.mocked(chromium.connectOverCDP).mockResolvedValue(browser as never);

    await printer.searchifyToFile("/tmp/input.pdf", "/tmp/output.pdf", {
      chromePath: "/custom/chrome",
    });

    vi.useFakeTimers();
    const closePromise = printer.close();
    closePromise.catch(() => {});
    await vi.advanceTimersByTimeAsync(5_100);
    await expect(closePromise).rejects.toThrow(
      "browser.close() timed out after 5000ms",
    );
    vi.useRealTimers();
    await new Promise((resolve) => setImmediate(resolve));
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

    await printer.searchifyToFile("/tmp/input.pdf", "/tmp/output.pdf", {
      chromePath: "/custom/chrome",
      verbose: true,
    });

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Optional profile asset copy failed"),
    );

    process.env.HOME = originalHome;
  });

  describe("waitForSearchifyComplete timeout paths", () => {
    it("returns true when OCR starts after 15s for large PDF", async () => {
      vi.useFakeTimers();

      const saveMock = vi.fn().mockResolvedValue({
        dataToSave: new Uint8Array([1, 2, 3]).buffer,
        fileName: "saved.pdf",
      });

      let pollCount = 0;
      const frame = createSimulatedViewerFrame({
        pageCount: 100,
        hasSearchifyText: false,
        saveMock,
        pollingStateFn: () => {
          pollCount++;
          if (pollCount <= 40) {
            return { started: false, done: false, hasSearchifyText: false };
          }
          return { started: true, done: true, hasSearchifyText: true };
        },
      });

      const { page } = createPage(frame);
      mockSearchifyRuntime({ chromePath: "/custom/chrome", viewerFrame: frame, page });

      const promise = printer.searchifyToFile("/tmp/input.pdf", "/tmp/output.pdf", {
        chromePath: "/custom/chrome",
      });
      promise.catch(() => {});

      await advanceUntilSettled(promise, 30_000);

      await expect(promise).resolves.toBeUndefined();
      expect(saveMock).toHaveBeenCalledWith("SEARCHIFIED");
    });

    it("returns true when hasSearchifyText detected without start signal after 5s", async () => {
      vi.useFakeTimers();

      const saveMock = vi.fn().mockResolvedValue({
        dataToSave: new Uint8Array([1, 2, 3]).buffer,
        fileName: "saved.pdf",
      });

      const frame = createSimulatedViewerFrame({
        pageCount: 3,
        hasSearchifyText: true,
        saveMock,
        pollingStateFn: () => ({ started: false, done: false, hasSearchifyText: true }),
      });

      const { page } = createPage(frame);
      mockSearchifyRuntime({ chromePath: "/custom/chrome", viewerFrame: frame, page });

      const promise = printer.searchifyToFile("/tmp/input.pdf", "/tmp/output.pdf", {
        chromePath: "/custom/chrome",
        verbose: true,
      });
      promise.catch(() => {});

      await advanceUntilSettled(promise, 15_000);

      await expect(promise).resolves.toBeUndefined();
      expect(saveMock).toHaveBeenCalledWith("SEARCHIFIED");
    });

    it("returns false when OCR never starts for text-only PDF", async () => {
      vi.useFakeTimers();

      const saveMock = vi.fn().mockResolvedValue({
        dataToSave: new Uint8Array([1, 2, 3]).buffer,
        fileName: "original.pdf",
      });

      const frame = createSimulatedViewerFrame({
        pageCount: 3,
        hasSearchifyText: false,
        saveMock,
        pollingStateFn: () => ({ started: false, done: false, hasSearchifyText: false }),
      });

      const { page } = createPage(frame);
      mockSearchifyRuntime({ chromePath: "/custom/chrome", viewerFrame: frame, page });

      const promise = printer.searchifyToFile("/tmp/input.pdf", "/tmp/output.pdf", {
        chromePath: "/custom/chrome",
        verbose: true,
      });
      promise.catch(() => {});

      await advanceUntilSettled(promise, 30_000);

      await expect(promise).resolves.toBeUndefined();
      expect(saveMock).toHaveBeenCalledWith("ORIGINAL");
    });

    it("returns false when OCR starts but never completes within maxWaitMs", async () => {
      vi.useFakeTimers();

      const saveMock = vi.fn().mockResolvedValue({
        dataToSave: new Uint8Array([1, 2, 3]).buffer,
        fileName: "original.pdf",
      });

      const frame = createSimulatedViewerFrame({
        pageCount: 3,
        hasSearchifyText: false,
        saveMock,
        pollingStateFn: () => ({ started: true, done: false, hasSearchifyText: false }),
      });

      const { page } = createPage(frame);
      mockSearchifyRuntime({ chromePath: "/custom/chrome", viewerFrame: frame, page });

      const promise = printer.searchifyToFile("/tmp/input.pdf", "/tmp/output.pdf", {
        chromePath: "/custom/chrome",
      });
      promise.catch(() => {});

      await advanceUntilSettled(promise, 30_000);

      await expect(promise).resolves.toBeUndefined();
      expect(saveMock).toHaveBeenCalledWith("ORIGINAL");
    });

    it("logs verbose messages during OCR polling and timeout", async () => {
      vi.useFakeTimers();

      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const frame = createSimulatedViewerFrame({
        pageCount: 3,
        hasSearchifyText: false,
        pollingStateFn: () => ({ started: true, done: false, hasSearchifyText: false }),
      });

      const { page } = createPage(frame);
      mockSearchifyRuntime({ chromePath: "/custom/chrome", viewerFrame: frame, page });

      const promise = printer.searchifyToFile("/tmp/input.pdf", "/tmp/output.pdf", {
        chromePath: "/custom/chrome",
        verbose: true,
      });
      promise.catch(() => {});

      await advanceUntilSettled(promise, 30_000);

      await expect(promise).resolves.toBeUndefined();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Waiting for OCR..."),
      );
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("OCR timed out after"),
      );
    });

    it("returns true with verbose log when OCR already complete after scrolling", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const frame = createSimulatedViewerFrame({
        pageCount: 3,
        hasSearchifyText: true,
        progressDoneAfterSetup: true,
      });

      mockSearchifyRuntime({ chromePath: "/custom/chrome", viewerFrame: frame });

      await printer.searchifyToFile("/tmp/input.pdf", "/tmp/output.pdf", {
        chromePath: "/custom/chrome",
        verbose: true,
      });

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("OCR already complete after scrolling"),
      );
    });

    it("logs verbose when viewer frame not ready on first attempt", async () => {
      vi.useFakeTimers();

      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      let viewerReadyCallCount = 0;
      const baseFrame = createSimulatedViewerFrame({ progressDoneAfterSetup: true });
      const frame: MockViewerFrame = {
        evaluate: vi.fn().mockImplementation(async (fn: unknown, params?: unknown) => {
          if (typeof fn !== "function") return undefined;
          const fnString = fn.toString();

          if (fnString.includes("viewer") && fnString.includes("currentController") && !fnString.includes("__searchifyProgress")) {
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

      await expect(promise).resolves.toBeUndefined();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Found 2 frames, waiting for viewer"),
      );
    });
  });
});
