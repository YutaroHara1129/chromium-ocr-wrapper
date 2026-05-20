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

function createViewerFrame(options?: {
  readyChecks?: Array<{
    hasSearchifyText: boolean;
    pdfSearchifySaveEnabled: boolean;
  }>;
  uploadResult?: Record<string, unknown>;
}): MockViewerFrame {
  const readyChecks = options?.readyChecks ?? [
    { hasSearchifyText: true, pdfSearchifySaveEnabled: true },
  ];
  const uploadResult = options?.uploadResult ?? {
    uploaded: false,
    reason: "NO_DATA",
  };

  let readyCall = 0;
  const frame: MockViewerFrame = {
    evaluate: vi.fn().mockImplementation(async (fnOrValue: unknown, _paramsOrFlag?: unknown) => {
      if (typeof fnOrValue !== "function") {
        return undefined;
      }

      const fnString = fnOrValue.toString();
      if (fnString.includes("hasSearchifyText_")) {
        readyCall++;
        return readyCall <= readyChecks.length
          ? readyChecks[readyCall - 1]
          : { hasSearchifyText: false, pdfSearchifySaveEnabled: false };
      }

      return uploadResult;
    }),
  };

  return frame;
}

function createExecutingViewerFrame(options: {
  saveResult?: { dataToSave: ArrayBuffer; fileName: string } | null;
  uploadError?: Error;
}): MockViewerFrame {
  const frame = createViewerFrame();

  frame.evaluate.mockImplementation(async (fn: unknown, params?: unknown) => {
    if (typeof fn !== "function") return undefined;

    const fnString = fn.toString();
    if (fnString.includes("hasSearchifyText_")) {
      return { hasSearchifyText: true, pdfSearchifySaveEnabled: true };
    }

    const originalViewer = (globalThis as Record<string, unknown>)["viewer"];
    const originalFetch = globalThis.fetch;

    try {
      (globalThis as Record<string, unknown>)["viewer"] = {
        currentController: {
          handlePluginMessage_: vi.fn(),
          save: vi.fn().mockResolvedValue(
            options.saveResult ?? {
              dataToSave: new Uint8Array([1, 2, 3]).buffer,
              fileName: "saved.pdf",
            },
          ),
        },
      };

      vi.spyOn(globalThis, "fetch").mockRejectedValue(
        options.uploadError ?? new TypeError("Failed to fetch"),
      );

      return await (fn as (p: unknown) => Promise<unknown>)(params);
    } finally {
      (globalThis as Record<string, unknown>)["viewer"] = originalViewer;
      globalThis.fetch = originalFetch;
    }
  });

  return frame;
}

function createPage(viewerFrame?: MockViewerFrame): { page: MockPage; frame: MockViewerFrame } {
  const frame = viewerFrame ?? createViewerFrame();

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
    const pageBundle = createPage();
    pageBundle.page.frames.mockReturnValue([{}]);

    const { chromeProcess, browser } = mockSearchifyRuntime({
      chromePath: "/custom/chrome",
      page: pageBundle.page,
    });

    await expect(
      printer.searchifyToFile("/tmp/input.pdf", "/tmp/output.pdf", { chromePath: "/custom/chrome" }),
    ).rejects.toThrow("PDF viewer frame not found");

    expect(pageBundle.page.close).toHaveBeenCalled();
    expect(browser.close).toHaveBeenCalled();
    expect(chromeProcess.kill).toHaveBeenCalled();
    expect(rm).toHaveBeenCalledWith("/tmp/chromium-ocr-test-profile", {
      recursive: true,
      force: true,
    });
  });

  it("renames temp file to output after fallback copy", async () => {
    mockSearchifyRuntime({ chromePath: "/custom/chrome" });

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
      expect.stringContaining("[ChromeSearchifyPrinter] Found"),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("[ChromeSearchifyPrinter] OCR check attempt 1:"),
      expect.objectContaining({
        hasSearchifyText: true,
        pdfSearchifySaveEnabled: true,
      }),
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

  it("close() ignores browser.close() and rm() failures", async () => {
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

    await expect(printer.close()).resolves.toBeUndefined();
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

  it("evaluate callback uses Blob and fetch, not Array.from(Uint8Array)", async () => {
    let capturedFunction: string = "";
    const viewerFrame = createViewerFrame();
    viewerFrame.evaluate.mockImplementation(async (fn: unknown) => {
      if (typeof fn !== "function") return undefined;
      const fnString = fn.toString();
      if (fnString.includes("hasSearchifyText_")) {
        return { hasSearchifyText: true, pdfSearchifySaveEnabled: true };
      }
      capturedFunction = fnString;
      return { uploaded: false, reason: "NO_DATA" };
    });

    mockSearchifyRuntime({
      chromePath: "/custom/chrome",
      viewerFrame,
    });

    await printer.searchifyToFile("/tmp/input.pdf", "/tmp/output.pdf", {
      chromePath: "/custom/chrome",
    });

    expect(capturedFunction).toContain("Blob");
    expect(capturedFunction).toContain("fetch");
    expect(capturedFunction).toContain("POST");
    expect(capturedFunction).not.toContain("Array.from");
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
    const viewerFrame = createExecutingViewerFrame({
      uploadError: new TypeError("Failed to fetch"),
    });

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
    const callCount = { value: 0 };
    const viewerFrame = createViewerFrame();
    viewerFrame.evaluate.mockImplementation(async (fn: unknown, params?: unknown) => {
      if (typeof fn !== "function") return undefined;

      const fnString = fn.toString();
      if (fnString.includes("hasSearchifyText_")) {
        return { hasSearchifyText: true, pdfSearchifySaveEnabled: true };
      }

      const originalViewer = (globalThis as Record<string, unknown>)["viewer"];
      const originalFetch = globalThis.fetch;

      try {
        callCount.value++;
        (globalThis as Record<string, unknown>)["viewer"] = {
          currentController: {
            handlePluginMessage_: vi.fn(),
            save: vi.fn().mockImplementation((saveType: string) => {
              if (saveType === "SEARCHIFIED") return Promise.resolve(null);
              return Promise.resolve({
                dataToSave: new Uint8Array([1, 2, 3]).buffer,
                fileName: "original.pdf",
              });
            }),
          },
        };

        vi.spyOn(globalThis, "fetch").mockRejectedValue(
          new TypeError("NetworkError when attempting to fetch resource"),
        );

        return await (fn as (p: unknown) => Promise<unknown>)(params);
      } finally {
        (globalThis as Record<string, unknown>)["viewer"] = originalViewer;
        globalThis.fetch = originalFetch;
      }
    });

    const { browser, chromeProcess } = mockSearchifyRuntime({
      chromePath: "/custom/chrome",
      viewerFrame,
    });

    await expect(
      printer.searchifyToFile("/tmp/input.pdf", "/tmp/output.pdf", {
        chromePath: "/custom/chrome",
      }),
    ).rejects.toThrow("NetworkError when attempting to fetch resource");

    expect(copyFile).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
    expect(browser.close).toHaveBeenCalled();
    expect(chromeProcess.kill).toHaveBeenCalled();
  });
});
