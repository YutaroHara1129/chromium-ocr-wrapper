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
      searchify: vi.fn().mockResolvedValue(new Uint8Array([4, 5, 6])),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as IChromeSearchifyPrinter,
    pdfInfoExtractor: {
      readPdfBytes: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
      getMetadata: vi.fn().mockResolvedValue({
        pageCount: 2,
        pages: [
          { width: 595.28, height: 841.89 },
          { width: 595.28, height: 841.89 },
        ],
      }),
    } as unknown as IPdfInfoExtractor,
    fileWriter: {
      ensureDir: vi.fn().mockResolvedValue(undefined),
      writeFile: vi.fn().mockResolvedValue(undefined),
    } as unknown as IFileWriter,
  };
}

describe("ConversionPipeline", () => {
  let pipeline: ConversionPipeline;
  let mocks: ReturnType<typeof createMocks>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const { stat } = await import("node:fs/promises");
    vi.mocked(stat).mockReset();
    vi.mocked(stat).mockRejectedValue(enoentError());

    mocks = createMocks();
    pipeline = new ConversionPipeline(
      mocks.searchifyPrinter,
      mocks.pdfInfoExtractor,
      mocks.fileWriter,
    );
  });

  it("runs full conversion pipeline", async () => {
    const result = await pipeline.convert({
      inputPath: "/input/test.pdf",
      outputPath: "/output/test.pdf",
    });

    expect.soft(result.inputPath).toBe("/input/test.pdf");
    expect.soft(result.outputPath).toBe("/output/test.pdf");
    expect.soft(result.pageCount).toBe(2);
    expect.soft(result.textSize).toBe(3);

    expect.soft(mocks.pdfInfoExtractor.readPdfBytes).toHaveBeenCalledWith("/input/test.pdf");
    expect.soft(mocks.pdfInfoExtractor.getMetadata).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]));
    expect.soft(mocks.searchifyPrinter.searchify).toHaveBeenCalledWith("/input/test.pdf", {
      chromePath: undefined,
      verbose: undefined,
    });
    expect.soft(mocks.fileWriter.ensureDir).toHaveBeenCalledWith(dirname("/output/test.pdf"));
    expect.soft(mocks.fileWriter.writeFile).toHaveBeenCalledWith(
      "/output/test.pdf",
      new Uint8Array([4, 5, 6]),
    );
  });

  it("generates default output path with _searchable suffix", async () => {
    const result = await pipeline.convert({
      inputPath: "/input/test.pdf",
    });

    expect(result.outputPath).toBe("/input/test_searchable.pdf");
  });

  it("does not call OCR when output exists and overwrite is false", async () => {
    const { stat } = await import("node:fs/promises");
    vi.mocked(stat).mockResolvedValueOnce({} as never);

    await expect(
      pipeline.convert({
        inputPath: "/input/test.pdf",
        outputPath: "/output/exists.pdf",
        overwrite: false,
      }),
    ).rejects.toThrow("Output already exists: /output/exists.pdf. Use --overwrite to replace.");

    expect(mocks.searchifyPrinter.searchify).not.toHaveBeenCalled();
    expect(mocks.fileWriter.writeFile).not.toHaveBeenCalled();
  });

  it("allows overwrite when output exists and overwrite is true", async () => {
    const { stat } = await import("node:fs/promises");
    vi.mocked(stat).mockResolvedValueOnce({} as never);

    const result = await pipeline.convert({
      inputPath: "/input/test.pdf",
      outputPath: "/output/exists.pdf",
      overwrite: true,
    });

    expect(result.outputPath).toBe("/output/exists.pdf");
    expect(mocks.searchifyPrinter.searchify).toHaveBeenCalledTimes(1);
    expect(mocks.fileWriter.writeFile).toHaveBeenCalled();
  });

  it("continues when stat returns ENOENT", async () => {
    const { stat } = await import("node:fs/promises");
    vi.mocked(stat).mockRejectedValueOnce(enoentError("/output/new.pdf"));

    const result = await pipeline.convert({
      inputPath: "/input/test.pdf",
      outputPath: "/output/new.pdf",
      overwrite: false,
    });

    expect(result.outputPath).toBe("/output/new.pdf");
    expect(mocks.searchifyPrinter.searchify).toHaveBeenCalledTimes(1);
  });

  it("propagates unexpected stat errors", async () => {
    const { stat } = await import("node:fs/promises");
    const error = eaccesError("/output/protected.pdf");
    vi.mocked(stat).mockRejectedValueOnce(error);

    await expect(
      pipeline.convert({
        inputPath: "/input/test.pdf",
        outputPath: "/output/protected.pdf",
        overwrite: false,
      }),
    ).rejects.toBe(error);

    expect(mocks.searchifyPrinter.searchify).not.toHaveBeenCalled();
    expect(mocks.fileWriter.writeFile).not.toHaveBeenCalled();
  });

  it("propagates readPdfBytes input errors", async () => {
    const error = new Error("failed to read input PDF");
    (mocks.pdfInfoExtractor.readPdfBytes as ReturnType<typeof vi.fn>).mockRejectedValueOnce(error);

    await expect(
      pipeline.convert({
        inputPath: "/input/broken.pdf",
        outputPath: "/output/test.pdf",
      }),
    ).rejects.toBe(error);

    expect(mocks.searchifyPrinter.searchify).not.toHaveBeenCalled();
    expect(mocks.fileWriter.writeFile).not.toHaveBeenCalled();
  });

  it("propagates getMetadata parse errors", async () => {
    const error = new Error("failed to parse PDF metadata");
    (mocks.pdfInfoExtractor.getMetadata as ReturnType<typeof vi.fn>).mockRejectedValueOnce(error);

    await expect(
      pipeline.convert({
        inputPath: "/input/broken.pdf",
        outputPath: "/output/test.pdf",
      }),
    ).rejects.toBe(error);

    expect(mocks.searchifyPrinter.searchify).not.toHaveBeenCalled();
    expect(mocks.fileWriter.writeFile).not.toHaveBeenCalled();
  });

  it("propagates searchify OCR errors", async () => {
    const error = new Error("OCR failed");
    (mocks.searchifyPrinter.searchify as ReturnType<typeof vi.fn>).mockRejectedValueOnce(error);

    await expect(
      pipeline.convert({
        inputPath: "/input/test.pdf",
        outputPath: "/output/test.pdf",
      }),
    ).rejects.toBe(error);

    expect(mocks.fileWriter.writeFile).not.toHaveBeenCalled();
  });

  it("propagates writeFile disk errors", async () => {
    const error = new Error("disk full");
    (mocks.fileWriter.writeFile as ReturnType<typeof vi.fn>).mockRejectedValueOnce(error);

    await expect(
      pipeline.convert({
        inputPath: "/input/test.pdf",
        outputPath: "/output/test.pdf",
      }),
    ).rejects.toBe(error);

    expect(mocks.searchifyPrinter.searchify).toHaveBeenCalledTimes(1);
  });

  it("passes chromePath and verbose options exactly to searchify", async () => {
    await pipeline.convert({
      inputPath: "/input/test.pdf",
      outputPath: "/output/test.pdf",
      chromePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      verbose: true,
    });

    expect(mocks.searchifyPrinter.searchify).toHaveBeenCalledWith("/input/test.pdf", {
      chromePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      verbose: true,
    });
  });

  it("returns textSize equal to output byte length exactly", async () => {
    const outputBytes = new Uint8Array([0, 1, 2, 3, 4, 5, 255]);
    (mocks.searchifyPrinter.searchify as ReturnType<typeof vi.fn>).mockResolvedValueOnce(outputBytes);

    const result = await pipeline.convert({
      inputPath: "/input/test.pdf",
      outputPath: "/output/test.pdf",
    });

    expect(result.textSize).toBe(outputBytes.length);
    expect(result.textSize).toBe(7);
  });
});
