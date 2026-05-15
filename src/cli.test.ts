import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./core/chrome-searchify-printer.js", () => ({
  ChromeSearchifyPrinter: vi.fn().mockImplementation(() => ({
    searchify: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
    close: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("./core/pipeline.js", () => ({
  ConversionPipeline: vi.fn().mockImplementation(() => ({
    convert: vi.fn().mockResolvedValue({
      inputPath: "/test.pdf",
      outputPath: "/test_searchable.pdf",
      pageCount: 1,
      textSize: 12059,
    }),
  })),
}));

vi.mock("./utils/pdf-info.js", () => ({
  PdfInfoExtractor: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("./utils/file-writer.js", () => ({
  NodeFileWriter: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("glob", () => ({
  glob: vi.fn().mockResolvedValue(["/test.pdf"]),
}));

import { runCli } from "./cli.js";
import { ConversionPipeline } from "./core/pipeline.js";

describe("runCli", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should throw when no args provided", async () => {
    await expect(runCli(["node", "cli.js"])).rejects.toThrow(
      "missing required argument",
    );
  });

  it("should process a PDF file when provided", async () => {
    const logSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);

    await runCli(["node", "cli.js", "/test.pdf"]);

    expect(ConversionPipeline).toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("/test.pdf"),
    );

    logSpy.mockRestore();
  });
});
