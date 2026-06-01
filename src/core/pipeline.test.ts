import { describe, it, expect, vi, beforeEach } from "vitest";
import { dirname } from "node:path";
import { ConversionPipeline } from "./pipeline.js";
import type {
  IChromeSearchifyPrinter,
  IFileWriter,
  IPdfAnalyzer,
  PdfAnalysis,
} from "../types/index.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    stat: vi.fn(),
    copyFile: vi.fn(),
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

function textOnlyAnalysis(overrides?: Partial<PdfAnalysis>): PdfAnalysis {
  return {
    pageCount: 2,
    kind: "text_only",
    hasExtractableText: true,
    hasImages: false,
    pagesNeedingOcr: 0,
    ...overrides,
  };
}

function imageOnlyAnalysis(overrides?: Partial<PdfAnalysis>): PdfAnalysis {
  return {
    pageCount: 3,
    kind: "image_only",
    hasExtractableText: false,
    hasImages: true,
    pagesNeedingOcr: 3,
    ...overrides,
  };
}

function blankAnalysis(overrides?: Partial<PdfAnalysis>): PdfAnalysis {
  return {
    pageCount: 1,
    kind: "blank",
    hasExtractableText: false,
    hasImages: false,
    pagesNeedingOcr: 0,
    ...overrides,
  };
}

function mixedAnalysis(overrides?: Partial<PdfAnalysis>): PdfAnalysis {
  return {
    pageCount: 3,
    kind: "mixed",
    hasExtractableText: true,
    hasImages: true,
    pagesNeedingOcr: 2,
    ...overrides,
  };
}

function createMocks(): {
  searchifyPrinter: IChromeSearchifyPrinter;
  pdfAnalyzer: IPdfAnalyzer;
  fileWriter: IFileWriter;
} {
  return {
    searchifyPrinter: {
      searchifyToFile: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as IChromeSearchifyPrinter,
    pdfAnalyzer: {
      analyze: vi.fn().mockResolvedValue(imageOnlyAnalysis()),
    } as unknown as IPdfAnalyzer,
    fileWriter: {
      ensureDir: vi.fn().mockResolvedValue(undefined),
    } as unknown as IFileWriter,
  };
}

async function getStatMock(): Promise<ReturnType<typeof import("node:fs/promises")>["stat"]> {
  const { stat } = await import("node:fs/promises");
  return vi.mocked(stat);
}

async function getCopyFileMock(): Promise<ReturnType<typeof import("node:fs/promises")>["copyFile"]> {
  const { copyFile } = await import("node:fs/promises");
  return vi.mocked(copyFile);
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
      mocks.pdfAnalyzer,
      mocks.fileWriter,
    );
  });

  async function setupStatForNewOutput(outputSize = 12059): Promise<void> {
    const stat = await getStatMock();
    stat.mockReset();
    stat.mockRejectedValueOnce(enoentError());
    stat.mockResolvedValueOnce({ size: outputSize } as never);
  }

  it("runs full OCR conversion for image-only PDF", async () => {
    await setupStatForNewOutput(12059);
    (mocks.pdfAnalyzer.analyze as ReturnType<typeof vi.fn>).mockResolvedValue(imageOnlyAnalysis());

    const result = await pipeline.convert({
      inputPath: "/input/test.pdf",
      outputPath: "/output/test.pdf",
    });

    expect.soft(result.inputPath).toBe("/input/test.pdf");
    expect.soft(result.outputPath).toBe("/output/test.pdf");
    expect.soft(result.pageCount).toBe(3);
    expect.soft(result.textSize).toBe(12059);
    expect.soft(result.kind).toBe("image_only");
    expect.soft(result.pagesMadeSearchable).toBe(3);

    expect.soft(mocks.pdfAnalyzer.analyze).toHaveBeenCalledWith("/input/test.pdf");
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

  it("copies text-only PDF without calling OCR", async () => {
    const stat = await getStatMock();
    stat.mockRejectedValueOnce(enoentError("/input/test_searchable.pdf"));
    stat.mockResolvedValueOnce({ size: 500 } as never);
    (mocks.pdfAnalyzer.analyze as ReturnType<typeof vi.fn>).mockResolvedValue(textOnlyAnalysis());
    const copyFile = await getCopyFileMock();

    const result = await pipeline.convert({
      inputPath: "/input/test.pdf",
      outputPath: "/output/test.pdf",
    });

    expect(result.kind).toBe("text_only");
    expect(result.pagesMadeSearchable).toBe(0);
    expect(copyFile).toHaveBeenCalledWith("/input/test.pdf", "/output/test.pdf");
    expect(mocks.searchifyPrinter.searchifyToFile).not.toHaveBeenCalled();
  });

  it("copies blank PDF without calling OCR", async () => {
    await setupStatForNewOutput(200);
    (mocks.pdfAnalyzer.analyze as ReturnType<typeof vi.fn>).mockResolvedValue(blankAnalysis());
    const copyFile = await getCopyFileMock();

    const result = await pipeline.convert({
      inputPath: "/input/test.pdf",
      outputPath: "/output/test.pdf",
    });

    expect(result.kind).toBe("blank");
    expect(result.pagesMadeSearchable).toBe(0);
    expect(copyFile).toHaveBeenCalledWith("/input/test.pdf", "/output/test.pdf");
    expect(mocks.searchifyPrinter.searchifyToFile).not.toHaveBeenCalled();
  });

  it("calls OCR for mixed PDF", async () => {
    await setupStatForNewOutput(8000);
    (mocks.pdfAnalyzer.analyze as ReturnType<typeof vi.fn>).mockResolvedValue(mixedAnalysis());

    const result = await pipeline.convert({
      inputPath: "/input/test.pdf",
      outputPath: "/output/test.pdf",
    });

    expect(result.kind).toBe("mixed");
    expect(result.pagesMadeSearchable).toBe(2);
    expect(mocks.searchifyPrinter.searchifyToFile).toHaveBeenCalledTimes(1);
  });

  it("generates default output path with _searchable suffix", async () => {
    const stat = await getStatMock();
    stat.mockRejectedValueOnce(enoentError("/input/test_searchable.pdf"));
    stat.mockResolvedValueOnce({ size: 12059 } as never);
    (mocks.pdfAnalyzer.analyze as ReturnType<typeof vi.fn>).mockResolvedValue(imageOnlyAnalysis({ pageCount: 2 }));

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
    (mocks.pdfAnalyzer.analyze as ReturnType<typeof vi.fn>).mockResolvedValue(imageOnlyAnalysis());

    const result = await pipeline.convert({
      inputPath: "/input/test.pdf",
      outputPath: "/output/exists.pdf",
      overwrite: true,
    });

    expect(result.outputPath).toBe("/output/exists.pdf");
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

  it("propagates analyzer errors", async () => {
    await setupStatForNewOutput();

    const error = new Error("failed to read input PDF");
    (mocks.pdfAnalyzer.analyze as ReturnType<typeof vi.fn>).mockRejectedValueOnce(error);

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
    (mocks.pdfAnalyzer.analyze as ReturnType<typeof vi.fn>).mockResolvedValue(imageOnlyAnalysis());

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
    (mocks.pdfAnalyzer.analyze as ReturnType<typeof vi.fn>).mockResolvedValue(imageOnlyAnalysis());

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
    (mocks.pdfAnalyzer.analyze as ReturnType<typeof vi.fn>).mockResolvedValue(imageOnlyAnalysis());

    const result = await pipeline.convert({
      inputPath: "/input/test.pdf",
      outputPath: "/output/test.pdf",
    });

    expect(result.textSize).toBe(98765);
  });

  it("rejects unknown (non-PDF) files", async () => {
    await setupStatForNewOutput();
    (mocks.pdfAnalyzer.analyze as ReturnType<typeof vi.fn>).mockResolvedValue({
      pageCount: 0,
      kind: "unknown",
      hasExtractableText: false,
      hasImages: false,
      pagesNeedingOcr: 0,
    });

    await expect(
      pipeline.convert({
        inputPath: "/input/invalid.pdf",
        outputPath: "/output/test.pdf",
      }),
    ).rejects.toThrow("File is not a valid PDF");

    expect(mocks.searchifyPrinter.searchifyToFile).not.toHaveBeenCalled();
  });
});
