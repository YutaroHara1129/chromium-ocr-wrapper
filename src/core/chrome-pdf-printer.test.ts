import { describe, it, expect, vi, beforeEach } from "vitest";
import { ChromePdfPrinter } from "./chrome-pdf-printer.js";
import type { IChromePdfPrinter } from "../types/index.js";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  stat: vi.fn().mockResolvedValue({ size: 1024 }),
}));

import { spawn } from "node:child_process";

function createMockProcess(closeCode: number = 0) {
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
  return {
    stderr: {
      on: (event: string, handler: (...args: unknown[]) => void) => {
        listeners["stderr:" + event] = listeners["stderr:" + event] ?? [];
        listeners["stderr:" + event]!.push(handler);
      },
    },
    on: (event: string, handler: (...args: unknown[]) => void) => {
      listeners[event] = listeners[event] ?? [];
      listeners[event].push(handler);
    },
    triggerClose: () => {
      const handlers = listeners["close"] ?? [];
      for (const h of handlers) h(closeCode);
    },
    triggerError: (err: Error) => {
      const handlers = listeners["error"] ?? [];
      for (const h of handlers) h(err);
    },
  };
}

describe("ChromePdfPrinter", () => {
  let printer: IChromePdfPrinter;

  beforeEach(() => {
    vi.clearAllMocks();
    printer = new ChromePdfPrinter();
  });

  it("should spawn Chrome with --print-to-pdf flags", async () => {
    const mockProc = createMockProcess(0);
    vi.mocked(spawn).mockReturnValue(mockProc as never);

    const promise = printer.printToPdf("/input/test.pdf", "/output/test.pdf", {
      chromePath: "/usr/bin/google-chrome",
    });

    mockProc.triggerClose();
    await promise;

    expect(spawn).toHaveBeenCalledWith(
      "/usr/bin/google-chrome",
      expect.arrayContaining([
        "--headless=new",
        "--print-to-pdf=" + resolve("/output/test.pdf"),
        "--print-to-pdf-no-header",
        "file://" + resolve("/input/test.pdf"),
      ]),
      expect.objectContaining({
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  });

  it("should reject when Chrome exits with non-zero code", async () => {
    const mockProc = createMockProcess(1);
    vi.mocked(spawn).mockReturnValue(mockProc as never);

    const promise = printer.printToPdf("/input/test.pdf", "/output/test.pdf", {
      chromePath: "/usr/bin/google-chrome",
    });

    mockProc.triggerClose();

    await expect(promise).rejects.toThrow("Chrome exited with code 1");
  });

  it("should reject when spawn fails", async () => {
    const mockProc = createMockProcess(0);
    vi.mocked(spawn).mockReturnValue(mockProc as never);

    const promise = printer.printToPdf("/input/test.pdf", "/output/test.pdf", {
      chromePath: "/nonexistent/chrome",
    });

    mockProc.triggerError(new Error("ENOENT"));

    await expect(promise).rejects.toThrow("Failed to spawn Chrome");
  });
});

function resolve(p: string): string {
  return p;
}
