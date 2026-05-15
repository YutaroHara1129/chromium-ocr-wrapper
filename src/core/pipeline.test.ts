import { describe, it, expect, vi, beforeEach } from "vitest";
import { ConversionPipeline } from "./pipeline.js";
import type {
  IChromePdfPrinter,
  IPdfInfoExtractor,
  IFileWriter,
} from "../types/index.js";

function createMockChromePdfPrinter(): IChromePdfPrinter {
  return {
    printToPdf: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockPdfInfoExtractor(): IPdfInfoExtractor {
  return {
    getMetadata: vi.fn().mockResolvedValue({
      pageCount: 1,
      pages: [{ width: 595.28, height: 841.89 }],
    }),
    readPdfBytes: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
  };
}

function createMockFileWriter(): IFileWriter {
  return {
    writeFile: vi.fn().mockResolvedValue(undefined),
    ensureDir: vi.fn().mockResolvedValue(undefined),
  };
}

describe("ConversionPipeline", () => {
  let pipeline: ConversionPipeline;
  let mockChromePdfPrinter: IChromePdfPrinter;
  let mockPdfInfoExtractor: IPdfInfoExtractor;
  let mockFileWriter: IFileWriter;

  beforeEach(() => {
    vi.clearAllMocks();
    mockChromePdfPrinter = createMockChromePdfPrinter();
    mockPdfInfoExtractor = createMockPdfInfoExtractor();
    mockFileWriter = createMockFileWriter();

    pipeline = new ConversionPipeline(
      mockChromePdfPrinter,
      mockPdfInfoExtractor,
      mockFileWriter,
    );
  });

  it("should run full conversion pipeline", async () => {
    const result = await pipeline.convert({
      inputPath: "/input/test.pdf",
      outputPath: "/output/test.pdf",
    });

    expect(result.inputPath).toBe("/input/test.pdf");
    expect(result.outputPath).toBe("/output/test.pdf");
    expect(result.pageCount).toBe(1);

    expect(mockPdfInfoExtractor.readPdfBytes).toHaveBeenCalledWith(
      "/input/test.pdf",
    );
    expect(mockChromePdfPrinter.printToPdf).toHaveBeenCalledWith(
      "/input/test.pdf",
      "/output/test.pdf",
      { chromePath: undefined, verbose: undefined },
    );
    expect(mockFileWriter.ensureDir).toHaveBeenCalledWith("/output");
  });

  it("should generate default output path when not specified", async () => {
    const result = await pipeline.convert({
      inputPath: "/input/test.pdf",
    });

    expect(result.outputPath).toBe("/input/test_searchable.pdf");
  });

  it("should pass chromePath and verbose options", async () => {
    await pipeline.convert({
      inputPath: "/input/test.pdf",
      outputPath: "/output/test.pdf",
      chromePath: "/usr/bin/chrome",
      verbose: true,
    });

    expect(mockChromePdfPrinter.printToPdf).toHaveBeenCalledWith(
      "/input/test.pdf",
      "/output/test.pdf",
      { chromePath: "/usr/bin/chrome", verbose: true },
    );
  });

  it("should throw when input file does not exist", async () => {
    vi.mocked(mockPdfInfoExtractor.readPdfBytes).mockRejectedValue(
      new Error("ENOENT: no such file"),
    );

    await expect(
      pipeline.convert({ inputPath: "/nonexistent.pdf" }),
    ).rejects.toThrow("ENOENT");
  });
});
