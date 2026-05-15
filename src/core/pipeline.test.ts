import { describe, it, expect, vi, beforeEach } from "vitest";
import { ConversionPipeline } from "./pipeline.js";
import type {
  IChromeSearchifyPrinter,
  IPdfInfoExtractor,
  IFileWriter,
} from "../types/index.js";

function createMocks() {
  return {
    searchifyPrinter: {
      searchify: vi.fn().mockResolvedValue(new Uint8Array([4, 5, 6])),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as IChromeSearchifyPrinter,
    pdfInfoExtractor: {
      getMetadata: vi.fn().mockResolvedValue({
        pageCount: 1,
        pages: [{ width: 595.28, height: 841.89 }],
      }),
      readPdfBytes: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
    } as unknown as IPdfInfoExtractor,
    fileWriter: {
      writeFile: vi.fn().mockResolvedValue(undefined),
      ensureDir: vi.fn().mockResolvedValue(undefined),
    } as unknown as IFileWriter,
  };
}

describe("ConversionPipeline", () => {
  let pipeline: ConversionPipeline;
  let mocks: ReturnType<typeof createMocks>;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks = createMocks();
    pipeline = new ConversionPipeline(
      mocks.searchifyPrinter,
      mocks.pdfInfoExtractor,
      mocks.fileWriter,
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
    expect(result.textSize).toBeGreaterThan(0);

    expect(mocks.searchifyPrinter.searchify).toHaveBeenCalledWith(
      "/input/test.pdf",
      { chromePath: undefined, verbose: undefined },
    );
    expect(mocks.fileWriter.writeFile).toHaveBeenCalledWith(
      "/output/test.pdf",
      expect.any(Uint8Array),
    );
  });

  it("should generate default output path with _searchable suffix", async () => {
    const result = await pipeline.convert({
      inputPath: "/input/test.pdf",
    });

    expect(result.outputPath).toBe("/input/test_searchable.pdf");
  });

  it("should throw when input file does not exist", async () => {
    vi.mocked(mocks.pdfInfoExtractor.readPdfBytes).mockRejectedValue(
      new Error("ENOENT: no such file"),
    );

    await expect(
      pipeline.convert({ inputPath: "/nonexistent.pdf" }),
    ).rejects.toThrow("ENOENT");
  });

  it("should pass chromePath and verbose options to searchifyPrinter", async () => {
    await pipeline.convert({
      inputPath: "/input/test.pdf",
      chromePath: "/usr/bin/chrome",
      verbose: true,
    });

    expect(mocks.searchifyPrinter.searchify).toHaveBeenCalledWith(
      "/input/test.pdf",
      { chromePath: "/usr/bin/chrome", verbose: true },
    );
  });
});
