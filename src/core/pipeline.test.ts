import { describe, it, expect, vi, beforeEach } from "vitest";
import { dirname } from "node:path";
import { ConversionPipeline } from "./pipeline.js";
import type {
  IChromeSearchifyPrinter,
  IFileWriter,
  IPdfInfoExtractor,
} from "../types/index.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    stat: vi.fn(),
  };
});

function enoentError(path = "/output/missing.pdf"): NodeJS.ErrnoException {
  const error = new Error(`ENOENT: no such file or directory, stat '${path}'`) as NodeJS.ErrnoException;
  error.code = "ENOENT";
  return error;
}

function eaccesError(path = "/output/protected.pdf"): NodeJS.ErrnoException {
  const error = new Error(`EACCES: permission denied, stat '${path}'`) as NodeJS.ErrnoException;
  error.code = "EACCES";
  return error;
}

function createMocks(): {
  searchifyPrinter: IChromeSearchifyPrinter;
  pdfInfoExtractor: IPdfInfoExtractor;
  fileWriter: IFileWriter;
} {
  return {
    searchifyPrinter: {
      searchifyToFile: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as IChromeSearchifyPrinter,
    pdfInfoExtractor: {
      getMetadataFromFile: vi.fn().mockResolvedValue({
        pageCount: 2,
        pages: [
          { width: 595.28, height: 841.89 },
          { width: 595.28, height: 841.89 },
        ],
      }),
    } as unknown as IPdfInfoExtractor,
    fileWriter: {
      ensureDir: vi.fn().mockResolvedValue(undefined),
    } as unknown as IFileWriter,
  };
}

async function getStatMock(): Promise<ReturnType<typeof import("node:fs/promises")>["stat"]> {
  const { stat } = await import("node:fs/promises");
  return vi.mocked(stat);
}

describe("ConversionPipeline", () => {
  let pipeline: ConversionPipeline;
  let mocks: ReturnType<typeof createMocks>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const stat = await getStatMock();
    stat.mockReset();

    mocks = createMocks();
    pipeline = new ConversionPipeline(
      mocks.searchifyPrinter,
      mocks.pdfInfoExtractor,
      mocks.fileWriter,
    );
  });

  async function setupStatForNewOutput(outputSize = 12059): Promise<void> {
    const stat = await getStatMock();
    stat.mockReset();
    stat.mockRejectedValueOnce(enoentError());
    stat.mockResolvedValueOnce({ size: outputSize } as never);
  }

  it("runs full conversion pipeline", async () => {
    await setupStatForNewOutput(12059);

    const result = await pipeline.convert({
      inputPath: "/input/test.pdf",
      outputPath: "/output/test.pdf",
    });

    expect.soft(result.inputPath).toBe("/input/test.pdf");
    expect.soft(result.outputPath).toBe("/output/test.pdf");
    expect.soft(result.pageCount).toBe(2);
    expect.soft(result.textSize).toBe(12059);

    expect.soft(mocks.pdfInfoExtractor.getMetadataFromFile).toHaveBeenCalledWith("/input/test.pdf");
    expect.soft(mocks.searchifyPrinter.searchifyToFile).toHaveBeenCalledWith(
      "/input/test.pdf",
      "/output/test.pdf",
      {
        chromePath: undefined,
        verbose: undefined,
      },
    );
    expect.soft(mocks.fileWriter.ensureDir).toHaveBeenCalledWith(dirname("/output/test.pdf"));
  });

  it("generates default output path with _searchable suffix", async () => {
    const stat = await getStatMock();
    stat.mockRejectedValueOnce(enoentError("/input/test_searchable.pdf"));
    stat.mockResolvedValueOnce({ size: 12059 } as never);

    const result = await pipeline.convert({
      inputPath: "/input/test.pdf",
    });

    expect(result.outputPath).toBe("/input/test_searchable.pdf");
  });

  it("does not call OCR when output exists and overwrite is false", async () => {
    const stat = await getStatMock();
    stat.mockResolvedValueOnce({} as never);

    await expect(
      pipeline.convert({
        inputPath: "/input/test.pdf",
        outputPath: "/output/exists.pdf",
        overwrite: false,
      }),
    ).rejects.toThrow("Output already exists: /output/exists.pdf. Use --overwrite to replace.");

    expect(mocks.searchifyPrinter.searchifyToFile).not.toHaveBeenCalled();
  });

  it("allows overwrite when output exists and overwrite is true", async () => {
    const stat = await getStatMock();
    stat.mockResolvedValueOnce({} as never);
    stat.mockResolvedValueOnce({ size: 500 } as never);

    const result = await pipeline.convert({
      inputPath: "/input/test.pdf",
      outputPath: "/output/exists.pdf",
      overwrite: true,
    });

    expect(result.outputPath).toBe("/output/exists.pdf");
    expect(mocks.searchifyPrinter.searchifyToFile).toHaveBeenCalledTimes(1);
  });

  it("continues when stat returns ENOENT", async () => {
    const stat = await getStatMock();
    stat.mockRejectedValueOnce(enoentError("/output/new.pdf"));
    stat.mockResolvedValueOnce({ size: 300 } as never);

    const result = await pipeline.convert({
      inputPath: "/input/test.pdf",
      outputPath: "/output/new.pdf",
      overwrite: false,
    });

    expect(result.outputPath).toBe("/output/new.pdf");
    expect(mocks.searchifyPrinter.searchifyToFile).toHaveBeenCalledTimes(1);
  });

  it("propagates unexpected stat errors", async () => {
    const stat = await getStatMock();
    const error = eaccesError("/output/protected.pdf");
    stat.mockRejectedValueOnce(error);

    await expect(
      pipeline.convert({
        inputPath: "/input/test.pdf",
        outputPath: "/output/protected.pdf",
        overwrite: false,
      }),
    ).rejects.toBe(error);

    expect(mocks.searchifyPrinter.searchifyToFile).not.toHaveBeenCalled();
  });

  it("propagates getMetadataFromFile input errors", async () => {
    await setupStatForNewOutput();

    const error = new Error("failed to read input PDF");
    (mocks.pdfInfoExtractor.getMetadataFromFile as ReturnType<typeof vi.fn>).mockRejectedValueOnce(error);

    await expect(
      pipeline.convert({
        inputPath: "/input/broken.pdf",
        outputPath: "/output/test.pdf",
      }),
    ).rejects.toBe(error);

    expect(mocks.searchifyPrinter.searchifyToFile).not.toHaveBeenCalled();
  });

  it("propagates searchifyToFile OCR errors", async () => {
    await setupStatForNewOutput();

    const error = new Error("OCR failed");
    (mocks.searchifyPrinter.searchifyToFile as ReturnType<typeof vi.fn>).mockRejectedValueOnce(error);

    await expect(
      pipeline.convert({
        inputPath: "/input/test.pdf",
        outputPath: "/output/test.pdf",
      }),
    ).rejects.toBe(error);
  });

  it("passes chromePath and verbose options to searchifyToFile", async () => {
    await setupStatForNewOutput(42);

    await pipeline.convert({
      inputPath: "/input/test.pdf",
      outputPath: "/output/test.pdf",
      chromePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      verbose: true,
    });

    expect(mocks.searchifyPrinter.searchifyToFile).toHaveBeenCalledWith(
      "/input/test.pdf",
      "/output/test.pdf",
      {
        chromePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        verbose: true,
      },
    );
  });

  it("returns textSize from output file stat", async () => {
    await setupStatForNewOutput(98765);

    const result = await pipeline.convert({
      inputPath: "/input/test.pdf",
      outputPath: "/output/test.pdf",
    });

    expect(result.textSize).toBe(98765);
  });
});
