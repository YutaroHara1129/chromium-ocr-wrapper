import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    cp: vi.fn().mockResolvedValue(undefined),
    mkdtemp: vi.fn().mockResolvedValue("/tmp/test-profile"),
    rm: vi.fn().mockResolvedValue(undefined),
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

import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { ChromeSearchifyPrinter } from "./chrome-searchify-printer.js";

function createMockPage(viewerEvaluateResult?: unknown): Record<string, unknown> {
  const searchifyEvaluate = vi.fn().mockResolvedValue({
    hasSearchifyText: true,
    pdfSearchifySaveEnabled: true,
  });
  const saveEvaluate = vi.fn().mockResolvedValue(
    viewerEvaluateResult ?? {
      dataToSave: Array.from(new Uint8Array([1, 2, 3, 4, 5])),
      fileName: "test.pdf",
    },
  );

  return {
    goto: vi.fn().mockResolvedValue(null),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    frames: vi
      .fn()
      .mockReturnValue([{}, { evaluate: searchifyEvaluate }]),
    _setSaveEvaluate: (fn: ReturnType<typeof vi.fn>) => {
      saveEvaluate.mockImplementation(fn);
    },
    close: vi.fn().mockResolvedValue(undefined),
    _searchifyEvaluate: searchifyEvaluate,
    _saveEvaluate: saveEvaluate,
  };
}

function createMockBrowser(): Record<string, unknown> {
  const mockPage = createMockPage();
  return {
    contexts: vi.fn().mockReturnValue([
      { newPage: vi.fn().mockResolvedValue(mockPage) },
    ]),
    newPage: vi.fn().mockResolvedValue(mockPage),
    close: vi.fn().mockResolvedValue(undefined),
    _mockPage: mockPage,
  };
}

describe("ChromeSearchifyPrinter", () => {
  let printer: ChromeSearchifyPrinter;

  beforeEach(() => {
    vi.clearAllMocks();
    printer = new ChromeSearchifyPrinter();
  });

  afterEach(async () => {
    try {
      await printer.close();
    } catch {
      // ignore
    }
  });

  it(
    "should spawn Chrome, connect CDP, navigate and save searchified PDF",
    { timeout: 30_000 },
    async () => {
      const mockBrowser = createMockBrowser();
      vi.mocked(chromium.connectOverCDP).mockResolvedValue(
        mockBrowser as never,
      );

      vi.mocked(spawn).mockReturnValue({
        on: vi.fn(),
        stderr: { on: vi.fn() },
        stdout: { on: vi.fn() },
        kill: vi.fn(),
      } as never);

      vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
      } as never);

      const saveResult = {
        dataToSave: Array.from(new Uint8Array([1, 2, 3, 4, 5])),
        fileName: "test.pdf",
      };
      mockBrowser._mockPage.frames.mockReturnValue([
        {},
        {
          evaluate: vi
            .fn()
            .mockResolvedValueOnce({
              hasSearchifyText: true,
              pdfSearchifySaveEnabled: true,
            })
            .mockResolvedValueOnce(saveResult),
        },
      ]);

      const result = await printer.searchify("/tmp/test-input.pdf", {
        chromePath:
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      });

      expect(spawn).toHaveBeenCalledWith(
        expect.stringContaining("Google Chrome"),
        expect.arrayContaining([
          expect.stringContaining("--remote-debugging-port="),
          expect.stringContaining("--user-data-dir="),
          "--enable-features=PdfSearchify,PdfSearchifySave",
        ]),
        expect.any(Object),
      );

      expect(chromium.connectOverCDP).toHaveBeenCalledWith(
        expect.stringContaining("http://127.0.0.1:"),
      );

      expect(mockBrowser._mockPage.goto).toHaveBeenCalledWith(
        "file:///tmp/test-input.pdf",
        expect.any(Object),
      );

      expect(result).toBeInstanceOf(Uint8Array);
      expect(result.length).toBe(5);
    },
  );

  it("should use browser contexts to create page", async () => {
    const mockBrowser = createMockBrowser();
    vi.mocked(chromium.connectOverCDP).mockResolvedValue(
      mockBrowser as never,
    );
    vi.mocked(spawn).mockReturnValue({
      on: vi.fn(),
      stderr: { on: vi.fn() },
      stdout: { on: vi.fn() },
      kill: vi.fn(),
    } as never);
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
    } as never);

    mockBrowser._mockPage.frames.mockReturnValue([
      {},
      {
        evaluate: vi
          .fn()
          .mockResolvedValueOnce({
            hasSearchifyText: true,
            pdfSearchifySaveEnabled: true,
          })
          .mockResolvedValueOnce({
            dataToSave: [1],
            fileName: "test.pdf",
          }),
      },
    ]);

    await printer.searchify("/tmp/test.pdf");

    expect(mockBrowser.contexts).toHaveBeenCalled();
  });

  it("should close browser, kill chrome process, and remove profile on close", async () => {
    const mockBrowser = createMockBrowser();
    const mockKill = vi.fn();
    vi.mocked(chromium.connectOverCDP).mockResolvedValue(
      mockBrowser as never,
    );
    vi.mocked(spawn).mockReturnValue({
      on: vi.fn(),
      stderr: { on: vi.fn() },
      stdout: { on: vi.fn() },
      kill: mockKill,
    } as never);
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
    } as never);

    mockBrowser._mockPage.frames.mockReturnValue([
      {},
      {
        evaluate: vi
          .fn()
          .mockResolvedValueOnce({
            hasSearchifyText: true,
            pdfSearchifySaveEnabled: true,
          })
          .mockResolvedValueOnce({
            dataToSave: [1],
            fileName: "test.pdf",
          }),
      },
    ]);

    await printer.searchify("/tmp/test.pdf");
    await printer.close();

    expect(mockBrowser.close).toHaveBeenCalled();
    expect(mockKill).toHaveBeenCalled();
  });
});
