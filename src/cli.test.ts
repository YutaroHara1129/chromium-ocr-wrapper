import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type MockFn = ReturnType<typeof vi.fn>;

type ConversionOptionsLike = {
  inputPath: string;
  outputPath?: string;
  overwrite?: boolean;
  verbose?: boolean;
  chromePath?: string;
};

type MockPrinterInstance = {
  searchify: MockFn;
  close: MockFn;
};

type MockPipelineInstance = {
  convert: MockFn;
};

const mocks = vi.hoisted(() => {
  const globMock = vi.fn();
  const statSyncMock = vi.fn();
  const realpathSyncMock = vi.fn((path: string) => path);

  const printerInstances: MockPrinterInstance[] = [];
  const pipelineInstances: MockPipelineInstance[] = [];

  const state: {
    convertImplementation?: (options: ConversionOptionsLike) => unknown;
  } = {};

  const defaultConvert = async (options: ConversionOptionsLike): Promise<{ inputPath: string; outputPath: string; pageCount: number; textSize: number }> => ({
    inputPath: options.inputPath,
    outputPath:
      options.outputPath ?? options.inputPath.replace(/\.pdf$/i, "_searchable.pdf"),
    pageCount: 1,
    textSize: 12059,
  });

  return {
    globMock,
    statSyncMock,
    realpathSyncMock,
    printerInstances,
    pipelineInstances,
    state,
    defaultConvert,
  };
});

vi.mock("glob", () => ({
  glob: mocks.globMock,
}));

vi.mock("node:fs", () => ({
  statSync: mocks.statSyncMock,
  realpathSync: mocks.realpathSyncMock,
}));

vi.mock("./core/chrome-searchify-printer.js", () => ({
  ChromeSearchifyPrinter: vi.fn().mockImplementation(() => {
    const instance = {
      searchify: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
      close: vi.fn().mockResolvedValue(undefined),
    };

    mocks.printerInstances.push(instance);
    return instance;
  }),
}));

vi.mock("./utils/pdf-info.js", () => ({
  PdfInfoExtractor: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("./utils/file-writer.js", () => ({
  NodeFileWriter: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("./core/pipeline.js", () => ({
  ConversionPipeline: vi.fn().mockImplementation(() => {
    const instance = {
      convert: vi.fn((options: ConversionOptionsLike) =>
        mocks.state.convertImplementation
          ? mocks.state.convertImplementation(options)
          : mocks.defaultConvert(options),
      ),
    };

    mocks.pipelineInstances.push(instance);
    return instance;
  }),
}));

import { glob } from "glob";
import { runCli } from "./cli.js";
import { ChromeSearchifyPrinter } from "./core/chrome-searchify-printer.js";
import { ConversionPipeline } from "./core/pipeline.js";

describe("runCli", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocks.printerInstances.length = 0;
    mocks.pipelineInstances.length = 0;
    mocks.state.convertImplementation = undefined;

    vi.mocked(ChromeSearchifyPrinter).mockImplementation(() => {
      const instance = {
        searchify: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
        close: vi.fn().mockResolvedValue(undefined),
      };
      mocks.printerInstances.push(instance);
      return instance;
    });

    vi.mocked(ConversionPipeline).mockImplementation(() => {
      const instance = {
        convert: vi.fn((options: ConversionOptionsLike) =>
          mocks.state.convertImplementation
            ? mocks.state.convertImplementation(options)
            : mocks.defaultConvert(options),
        ),
      };
      mocks.pipelineInstances.push(instance);
      return instance;
    });

    mocks.globMock.mockReset();
    mocks.globMock.mockResolvedValue(["/input.pdf"]);

    mocks.statSyncMock.mockReset();
    mocks.statSyncMock.mockImplementation(() => {
      throw new Error("ENOENT");
    });

    mocks.realpathSyncMock.mockReset();
    mocks.realpathSyncMock.mockImplementation((path: string) => path);

    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  const stdoutText = (spy: ReturnType<typeof vi.spyOn>): string =>
    spy.mock.calls.map((call) => String(call[0])).join("");

  it("missing required input rejects with Commander error", async () => {
    let error: unknown;

    try {
      await runCli(["node", "cli.js"]);
    } catch (caught) {
      error = caught;
    }

    expect(
      error,
      "runCli should reject when required input is missing",
    ).toBeInstanceOf(Error);
    expect(
      (error as Error).message,
      `actual error=${error instanceof Error ? error.message : String(error)}`,
    ).toMatch(/missing required argument/i);
  });

  it("--help prints help text with all options", async () => {
    const writeSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((() => true) as typeof process.stdout.write);

    await expect(runCli(["node", "cli.js", "--help"])).rejects.toMatchObject({
      code: "commander.helpDisplayed",
    });

    const help = stdoutText(writeSpy);

    expect(help).toContain("Usage: chromium-ocr [options] <input>");
    expect(help).toContain("Convert image-only PDFs to searchable PDFs");
    expect(help).toContain("-o, --output <path>");
    expect(help).toContain("--chrome-path <path>");
    expect(help).toContain("--overwrite");
    expect(help).toContain("-v, --verbose");
    expect(help).toContain("-V, --version");
    expect(help).toContain("-h, --help");
  });

  it("--version prints package version", async () => {
    const writeSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((() => true) as typeof process.stdout.write);

    await expect(runCli(["node", "cli.js", "--version"])).rejects.toMatchObject({
      code: "commander.version",
    });

    expect(stdoutText(writeSpy)).toContain("0.1.0-beta.0");
  });

  it("single PDF input converts successfully", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    mocks.globMock.mockResolvedValue(["/docs/input.pdf"]);

    await runCli(["node", "cli.js", "/docs/input.pdf"]);

    expect(glob).toHaveBeenCalledWith("/docs/input.pdf", {
      absolute: true,
      nodir: true,
    });
    expect(ChromeSearchifyPrinter).toHaveBeenCalledTimes(1);
    expect(ConversionPipeline).toHaveBeenCalledTimes(1);
    expect(mocks.pipelineInstances[0].convert).toHaveBeenCalledWith({
      inputPath: "/docs/input.pdf",
      outputPath: undefined,
      overwrite: undefined,
      verbose: undefined,
      chromePath: undefined,
    });
    expect(logSpy).toHaveBeenCalledWith(
      "Done: /docs/input.pdf -> /docs/input_searchable.pdf (1 pages, 12059 bytes)",
    );
  });

  it("--verbose flag passes through and logs Processing message", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    mocks.globMock.mockResolvedValue(["/docs/input.pdf"]);

    await runCli(["node", "cli.js", "--verbose", "/docs/input.pdf"]);

    expect(mocks.pipelineInstances[0].convert).toHaveBeenCalledWith(
      expect.objectContaining({
        inputPath: "/docs/input.pdf",
        verbose: true,
      }),
    );
    expect(logSpy).toHaveBeenCalledWith("Processing: /docs/input.pdf");
  });

  it("--chrome-path passes through to conversion options", async () => {
    mocks.globMock.mockResolvedValue(["/docs/input.pdf"]);

    await runCli([
      "node",
      "cli.js",
      "--chrome-path",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/docs/input.pdf",
    ]);

    expect(mocks.pipelineInstances[0].convert).toHaveBeenCalledWith(
      expect.objectContaining({
        chromePath: "/Applications/Chromium.app/Contents/MacOS/Chromium",
      }),
    );
  });

  it("--overwrite passes through to conversion options", async () => {
    mocks.globMock.mockResolvedValue(["/docs/input.pdf"]);

    await runCli(["node", "cli.js", "--overwrite", "/docs/input.pdf"]);

    expect(mocks.pipelineInstances[0].convert).toHaveBeenCalledWith(
      expect.objectContaining({
        overwrite: true,
      }),
    );
  });

  it("--output file path is resolved and passed through", async () => {
    mocks.globMock.mockResolvedValue(["/docs/input.pdf"]);

    await runCli([
      "node",
      "cli.js",
      "--output",
      "/output/searchable.pdf",
      "/docs/input.pdf",
    ]);

    expect(mocks.pipelineInstances[0].convert).toHaveBeenCalledWith(
      expect.objectContaining({
        inputPath: "/docs/input.pdf",
        outputPath: "/output/searchable.pdf",
      }),
    );
  });

  it("--output directory maps each input to _searchable suffixed file", async () => {
    mocks.globMock.mockResolvedValue(["/docs/a.pdf", "/docs/b.PDF"]);
    mocks.statSyncMock.mockReturnValue({
      isDirectory: () => true,
    });

    await runCli(["node", "cli.js", "--output", "/output", "/docs/*.pdf"]);

    // CLI output-directory resolution uses a fixed lowercase ".pdf" suffix
    // regardless of input extension case, which differs from
    // ConversionPipeline.generateOutputPath (preserves extension case).
    expect(mocks.pipelineInstances[0].convert).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        inputPath: "/docs/a.pdf",
        outputPath: "/output/a_searchable.pdf",
      }),
    );
    expect(mocks.pipelineInstances[0].convert).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        inputPath: "/docs/b.PDF",
        outputPath: "/output/b_searchable.pdf",
      }),
    );
  });

  it("non-PDF glob matches are filtered out", async () => {
    mocks.globMock.mockResolvedValue([
      "/docs/a.pdf",
      "/docs/readme.txt",
      "/docs/b.PDF",
      "/docs/image.png",
    ]);

    await runCli(["node", "cli.js", "/docs/*"]);

    expect(mocks.pipelineInstances[0].convert).toHaveBeenCalledTimes(2);
    expect(mocks.pipelineInstances[0].convert).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ inputPath: "/docs/a.pdf" }),
    );
    expect(mocks.pipelineInstances[0].convert).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ inputPath: "/docs/b.PDF" }),
    );
  });

  it("no matching PDF files logs error and sets process.exitCode", async () => {
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    mocks.globMock.mockResolvedValue([]);

    await runCli(["node", "cli.js", "/docs/*.pdf"]);

    expect(errorSpy).toHaveBeenCalledWith(
      "No PDF files found matching the input pattern.",
    );
    expect(process.exitCode).toBe(1);
    expect(ConversionPipeline).not.toHaveBeenCalled();
  });

  it("conversion failure logs error and continues to next file, sets process.exitCode = 1", async () => {
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    mocks.globMock.mockResolvedValue(["/docs/bad.pdf", "/docs/good.pdf"]);
    mocks.state.convertImplementation = vi.fn(
      async (options: ConversionOptionsLike) => {
        if (options.inputPath === "/docs/bad.pdf") {
          throw new Error("OCR failed");
        }

        return {
          inputPath: options.inputPath,
          outputPath: "/docs/good_searchable.pdf",
          pageCount: 2,
          textSize: 42,
        };
      },
    );

    await runCli(["node", "cli.js", "/docs/*.pdf"]);

    expect(mocks.pipelineInstances[0].convert).toHaveBeenCalledTimes(2);
    expect(errorSpy).toHaveBeenCalledWith("Failed: /docs/bad.pdf: OCR failed");
    expect(logSpy).toHaveBeenCalledWith(
      "Done: /docs/good.pdf -> /docs/good_searchable.pdf (2 pages, 42 bytes)",
    );
    expect(process.exitCode).toBe(1);
  });

  it("printer cleanup runs in finally even on conversion throw", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    mocks.globMock.mockResolvedValue(["/docs/input.pdf"]);
    mocks.state.convertImplementation = vi.fn(async () => {
      throw new Error("conversion failed");
    });

    await runCli(["node", "cli.js", "/docs/input.pdf"]);

    expect(mocks.printerInstances[0].close).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);
  });

  it("signal handlers are registered once per run and removed after run", async () => {
    const registered = new Map<string | symbol, (...args: unknown[]) => void>();

    const onceSpy = vi
      .spyOn(process, "once")
      .mockImplementation(
        ((event: string | symbol, listener: (...args: unknown[]) => void) => {
          registered.set(event, listener);
          return process;
        }) as typeof process.once,
      );
    const removeListenerSpy = vi
      .spyOn(process, "removeListener")
      .mockImplementation((() => process) as typeof process.removeListener);

    mocks.globMock.mockResolvedValue(["/docs/input.pdf"]);

    await runCli(["node", "cli.js", "/docs/input.pdf"]);

    const sigintHandler = registered.get("SIGINT");
    const sigtermHandler = registered.get("SIGTERM");

    const registeredEvents = Array.from(registered.keys()).map(String);

    expect(onceSpy).toHaveBeenCalledWith("SIGINT", expect.any(Function));
    expect(onceSpy).toHaveBeenCalledWith("SIGTERM", expect.any(Function));
    expect(
      sigintHandler,
      `registered events=${JSON.stringify(registeredEvents)} onceCalls=${JSON.stringify(onceSpy.mock.calls.map(([ev]) => String(ev)))}`,
    ).toBeDefined();
    expect(
      sigtermHandler,
      `registered events=${JSON.stringify(registeredEvents)} onceCalls=${JSON.stringify(onceSpy.mock.calls.map(([ev]) => String(ev)))}`,
    ).toBeDefined();
    expect(removeListenerSpy).toHaveBeenCalledWith("SIGINT", sigintHandler);
    expect(removeListenerSpy).toHaveBeenCalledWith("SIGTERM", sigtermHandler);
  });

  it("cleanup is idempotent when signal handler and finally both run", async () => {
    const registered = new Map<string | symbol, (...args: unknown[]) => void>();

    vi.spyOn(process, "once").mockImplementation(
      ((event: string | symbol, listener: (...args: unknown[]) => void) => {
        registered.set(event, listener);
        return process;
      }) as typeof process.once,
    );
    vi.spyOn(process, "removeListener").mockImplementation(
      (() => process) as typeof process.removeListener,
    );

    mocks.globMock.mockResolvedValue(["/docs/input.pdf"]);
    mocks.state.convertImplementation = vi.fn(
      async (options: ConversionOptionsLike) => {
        registered.get("SIGINT")?.();

        return {
          inputPath: options.inputPath,
          outputPath: "/docs/input_searchable.pdf",
          pageCount: 1,
          textSize: 10,
        };
      },
    );

    await runCli(["node", "cli.js", "/docs/input.pdf"]);

    expect(mocks.printerInstances[0].close).toHaveBeenCalledTimes(1);
  });
});
