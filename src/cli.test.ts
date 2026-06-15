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
  searchifyToFile: MockFn;
  close: MockFn;
  killProcessGroup: MockFn;
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

  const defaultConvert = async (options: ConversionOptionsLike): Promise<{ inputPath: string; outputPath: string; pageCount: number; textSize: number; kind: string; pagesMadeSearchable: number }> => ({
    inputPath: options.inputPath,
    outputPath:
      options.outputPath ?? options.inputPath.replace(/\.pdf$/i, "_searchable.pdf"),
    pageCount: 1,
    textSize: 12059,
    kind: "image_only",
    pagesMadeSearchable: 1,
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
  hasMagic: vi.fn((pattern: string) => {
    if (typeof pattern !== "string") return false;
    return /[*?{}[\]]/.test(pattern);
  }),
}));

vi.mock("node:fs", () => ({
  statSync: mocks.statSyncMock,
  realpathSync: mocks.realpathSyncMock,
}));

vi.mock("./core/chrome-searchify-printer.js", () => ({
  ChromeSearchifyPrinter: vi.fn().mockImplementation(() => {
    const instance = {
      searchifyToFile: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      killProcessGroup: vi.fn(),
    };

    mocks.printerInstances.push(instance);
    return instance;
  }),
}));

vi.mock("./utils/pdf-info.js", () => ({
  PdfInfoExtractor: vi.fn().mockImplementation(() => ({})),
  analyzePdfContent: vi.fn(),
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
import { runCli, CLI_FLAGS, formatOcrReport, handleCliError } from "./cli.js";
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
        searchifyToFile: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        killProcessGroup: vi.fn(),
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

  it("missing required input rejects with error and exitCode", async () => {
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    await runCli(["node", "cli.js"]);

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("input"),
    );
    expect(process.exitCode).toBe(1);
  });

  it("--help prints help text with all options", async () => {
    const writeSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((() => true) as typeof process.stdout.write);

    await expect(runCli(["node", "cli.js", "--help"])).rejects.toMatchObject({
      code: "commander.helpDisplayed",
    });

    const help = stdoutText(writeSpy);

    expect(help).toContain("Usage: chromium-ocr [options] [input...]");
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
    mocks.statSyncMock.mockImplementation(() => {
      throw new Error("ENOENT");
    });

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
      "Done: /docs/input.pdf -> /docs/input_searchable.pdf (1 pages, 1 pages made searchable)",
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
          kind: "image_only",
          pagesMadeSearchable: 2,
        };
      },
    );

    await runCli(["node", "cli.js", "/docs/*.pdf"]);

    expect(mocks.pipelineInstances[0].convert).toHaveBeenCalledTimes(2);
    expect(errorSpy).toHaveBeenCalledWith("Failed: /docs/bad.pdf: OCR failed");
    expect(logSpy).toHaveBeenCalledWith(
      "Done: /docs/good.pdf -> /docs/good_searchable.pdf (2 pages, 2 pages made searchable)",
    );
    expect(process.exitCode).toBe(1);
  });

  it("handles non-Error thrown values in conversion", async () => {
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    mocks.globMock.mockResolvedValue(["/docs/bad.pdf"]);
    mocks.state.convertImplementation = vi.fn(async () => {
      throw "string error";
    });

    await runCli(["node", "cli.js", "/docs/bad.pdf"]);

    expect(errorSpy).toHaveBeenCalledWith("Failed: /docs/bad.pdf: string error");
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

    expect(mocks.printerInstances[0].killProcessGroup).toHaveBeenCalledTimes(1);
    expect(mocks.printerInstances[0].close).toHaveBeenCalledTimes(1);
  });

  it("CLI_FLAGS defines all options with correct metadata", async () => {
    expect(CLI_FLAGS).toEqual([
      {
        flags: "-o, --output <path>",
        description: "Output file or directory path",
        hasValue: true,
      },
      {
        flags: "--chrome-path <path>",
        description: "Path to Chrome/Chromium executable",
        hasValue: true,
      },
      {
        flags: "--overwrite",
        description: "Overwrite existing output files",
        hasValue: false,
      },
      {
        flags: "-v, --verbose",
        description: "Enable verbose logging",
        hasValue: false,
      },
    ]);
  });

  it("logs 'OCR not needed' for text_only PDF", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    mocks.globMock.mockResolvedValue(["/docs/text.pdf"]);
    mocks.state.convertImplementation = vi.fn(
      async (options: ConversionOptionsLike) => ({
        inputPath: options.inputPath,
        outputPath: options.inputPath.replace(/\.pdf$/i, "_searchable.pdf"),
        pageCount: 1,
        textSize: 0,
        kind: "text_only",
        pagesMadeSearchable: 0,
      }),
    );

    await runCli(["node", "cli.js", "/docs/text.pdf"]);

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("OCR not needed"),
    );
  });

  it("logs 'OCR not needed' for blank PDF", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    mocks.globMock.mockResolvedValue(["/docs/blank.pdf"]);
    mocks.state.convertImplementation = vi.fn(
      async (options: ConversionOptionsLike) => ({
        inputPath: options.inputPath,
        outputPath: options.inputPath.replace(/\.pdf$/i, "_searchable.pdf"),
        pageCount: 1,
        textSize: 0,
        kind: "blank",
        pagesMadeSearchable: 0,
      }),
    );

    await runCli(["node", "cli.js", "/docs/blank.pdf"]);

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("OCR not needed"),
    );
  });

  describe("multiple argument inputs", () => {
    it("multiple file arguments are processed sequentially", async () => {
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      mocks.globMock.mockImplementation((pattern: string) => {
        if (pattern === "/docs/a.pdf") return Promise.resolve(["/docs/a.pdf"]);
        if (pattern === "/docs/b.pdf") return Promise.resolve(["/docs/b.pdf"]);
        return Promise.resolve([]);
      });

      await runCli(["node", "cli.js", "/docs/a.pdf", "/docs/b.pdf"]);

      expect(mocks.pipelineInstances[0].convert).toHaveBeenCalledTimes(2);
      expect(mocks.pipelineInstances[0].convert).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ inputPath: "/docs/a.pdf" }),
      );
      expect(mocks.pipelineInstances[0].convert).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ inputPath: "/docs/b.pdf" }),
      );
    });

    it("glob patterns mixed with file arguments are resolved", async () => {
      mocks.globMock.mockImplementation((pattern: string) => {
        if (pattern === "/batch/*.pdf")
          return Promise.resolve(["/batch/x.pdf", "/batch/y.pdf"]);
        if (pattern === "/single.pdf") return Promise.resolve(["/single.pdf"]);
        return Promise.resolve([]);
      });

      await runCli(["node", "cli.js", "/batch/*.pdf", "/single.pdf"]);

      expect(mocks.pipelineInstances[0].convert).toHaveBeenCalledTimes(3);
    });

    it("all inputs yield zero files -> error", async () => {
      const errorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);

      mocks.globMock.mockResolvedValue([]);

      await runCli(["node", "cli.js", "/nonexistent1.pdf", "/nonexistent2.pdf"]);

      expect(errorSpy).toHaveBeenCalledWith(
        "No PDF files found matching the input pattern.",
      );
      expect(process.exitCode).toBe(1);
    });

    it("duplicate paths across inputs are deduplicated", async () => {
      mocks.globMock.mockImplementation((pattern: string) => {
        if (pattern === "/docs/a.pdf") return Promise.resolve(["/docs/a.pdf"]);
        if (pattern === "/docs/*.pdf")
          return Promise.resolve(["/docs/a.pdf", "/docs/b.pdf"]);
        return Promise.resolve([]);
      });

      await runCli(["node", "cli.js", "/docs/a.pdf", "/docs/*.pdf"]);

      const calls = mocks.pipelineInstances[0].convert.mock.calls.map(
        (c: unknown[]) => (c[0] as ConversionOptionsLike).inputPath,
      );
      expect(calls).toEqual(["/docs/a.pdf", "/docs/b.pdf"]);
    });
  });

  describe("glob output path resolution", () => {
    it("recursive glob with --output directory keeps nested outputs under the output dir", async () => {
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      const cwd = process.cwd();
      const inputPattern = `${cwd}/docs/**/*.pdf`;
      mocks.globMock.mockImplementation((pattern: string) => {
        if (pattern === inputPattern) {
          return Promise.resolve([`${cwd}/docs/sub/nested.pdf`]);
        }
        return Promise.resolve([]);
      });
      mocks.statSyncMock.mockImplementation((p: string) => {
        if (p === "/out") return { isDirectory: () => true } as ReturnType<typeof statSync>;
        throw new Error("ENOENT");
      });

      await runCli(["node", "cli.js", "--output", "/out", "docs/**/*.pdf"]);

      expect(glob).toHaveBeenCalledWith(inputPattern, {
        absolute: true,
        nodir: true,
      });
      expect(mocks.pipelineInstances[0].convert).toHaveBeenCalledWith(
        expect.objectContaining({
          inputPath: `${cwd}/docs/sub/nested.pdf`,
          outputPath: "/out/sub/nested_searchable.pdf",
        }),
      );
    });

    it("glob with literal prefix and --output directory keeps the prefix structure", async () => {
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      const cwd = process.cwd();
      const inputPattern = `${cwd}/docs/2024/*.pdf`;
      mocks.globMock.mockImplementation((pattern: string) => {
        if (pattern === inputPattern) {
          return Promise.resolve([`${cwd}/docs/2024/report.pdf`]);
        }
        return Promise.resolve([]);
      });
      mocks.statSyncMock.mockImplementation((p: string) => {
        if (p === "/out") return { isDirectory: () => true } as ReturnType<typeof statSync>;
        throw new Error("ENOENT");
      });

      await runCli(["node", "cli.js", "--output", "/out", "docs/2024/*.pdf"]);

      expect(glob).toHaveBeenCalledWith(inputPattern, {
        absolute: true,
        nodir: true,
      });
      expect(mocks.pipelineInstances[0].convert).toHaveBeenCalledWith(
        expect.objectContaining({
          inputPath: `${cwd}/docs/2024/report.pdf`,
          outputPath: "/out/report_searchable.pdf",
        }),
      );
    });

    it("glob without a directory prefix maps directly under the output dir", async () => {
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      const cwd = process.cwd();
      const inputPattern = `${cwd}/*.pdf`;
      mocks.globMock.mockImplementation((pattern: string) => {
        if (pattern === inputPattern) {
          return Promise.resolve([`${cwd}/a.pdf`]);
        }
        return Promise.resolve([]);
      });
      mocks.statSyncMock.mockImplementation((p: string) => {
        if (p === "/out") return { isDirectory: () => true } as ReturnType<typeof statSync>;
        throw new Error("ENOENT");
      });

      await runCli(["node", "cli.js", "--output", "/out", "*.pdf"]);

      expect(glob).toHaveBeenCalledWith(inputPattern, {
        absolute: true,
        nodir: true,
      });
      expect(mocks.pipelineInstances[0].convert).toHaveBeenCalledWith(
        expect.objectContaining({
          inputPath: `${cwd}/a.pdf`,
          outputPath: "/out/a_searchable.pdf",
        }),
      );
    });

    it("brace expansion without * resolves baseDir and keeps output under --output dir", async () => {
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      const cwd = process.cwd();
      const inputPattern = `${cwd}/docs/{a,b}/file.pdf`;
      mocks.globMock.mockImplementation((pattern: string) => {
        if (pattern === inputPattern) {
          return Promise.resolve([`${cwd}/docs/a/file.pdf`]);
        }
        return Promise.resolve([]);
      });
      mocks.statSyncMock.mockImplementation((p: string) => {
        if (p === "/out") return { isDirectory: () => true } as ReturnType<typeof statSync>;
        throw new Error("ENOENT");
      });

      await runCli(["node", "cli.js", "--output", "/out", "docs/{a,b}/file.pdf"]);

      expect(mocks.pipelineInstances[0].convert).toHaveBeenCalledWith(
        expect.objectContaining({
          inputPath: `${cwd}/docs/a/file.pdf`,
          outputPath: "/out/a/file_searchable.pdf",
        }),
      );
    });

    it("character class without * resolves baseDir and keeps output under --output dir", async () => {
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      const cwd = process.cwd();
      const inputPattern = `${cwd}/docs/[ab]/file.pdf`;
      mocks.globMock.mockImplementation((pattern: string) => {
        if (pattern === inputPattern) {
          return Promise.resolve([`${cwd}/docs/a/file.pdf`]);
        }
        return Promise.resolve([]);
      });
      mocks.statSyncMock.mockImplementation((p: string) => {
        if (p === "/out") return { isDirectory: () => true } as ReturnType<typeof statSync>;
        throw new Error("ENOENT");
      });

      await runCli(["node", "cli.js", "--output", "/out", "docs/[ab]/file.pdf"]);

      expect(mocks.pipelineInstances[0].convert).toHaveBeenCalledWith(
        expect.objectContaining({
          inputPath: `${cwd}/docs/a/file.pdf`,
          outputPath: "/out/a/file_searchable.pdf",
        }),
      );
    });

    it("rejects output path that escapes the --output directory", async () => {
      const errorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);

      const cwd = process.cwd();
      mocks.globMock.mockImplementation((pattern: string) => {
        if (pattern.includes("outside")) {
          return Promise.resolve(["/completely/different/file.pdf"]);
        }
        return Promise.resolve([]);
      });
      mocks.statSyncMock.mockImplementation((p: string) => {
        if (p === "/out") return { isDirectory: () => true } as ReturnType<typeof statSync>;
        throw new Error("ENOENT");
      });

      await runCli(["node", "cli.js", "--output", "/out", `${cwd}/outside/**/*.pdf`]);

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("outside the output directory"),
      );
      expect(process.exitCode).toBe(1);
      expect(ConversionPipeline).not.toHaveBeenCalled();
    });
  });

  describe("directory inputs", () => {
    it("directory input is resolved recursively, --output absent", async () => {
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      mocks.globMock.mockImplementation((pattern: string) => {
        if (pattern === "/mydir/**/*.pdf")
          return Promise.resolve([
            "/mydir/top.pdf",
            "/mydir/sub/nested.pdf",
          ]);
        return Promise.resolve([]);
      });
      mocks.statSyncMock.mockImplementation((p: string) => {
        if (p === "/mydir") return { isDirectory: () => true } as ReturnType<typeof statSync>;
        throw new Error("ENOENT");
      });

      await runCli(["node", "cli.js", "/mydir"]);

      expect(glob).toHaveBeenCalledWith("/mydir/**/*.pdf", {
        absolute: true,
        nodir: true,
      });
      expect(mocks.pipelineInstances[0].convert).toHaveBeenCalledTimes(2);
      expect(mocks.pipelineInstances[0].convert).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          inputPath: "/mydir/top.pdf",
          outputPath: undefined,
        }),
      );
      expect(mocks.pipelineInstances[0].convert).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          inputPath: "/mydir/sub/nested.pdf",
          outputPath: undefined,
        }),
      );
    });

    it("directory with no PDFs logs error", async () => {
      const errorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);

      mocks.globMock.mockResolvedValue([]);
      mocks.statSyncMock.mockImplementation((p: string) => {
        if (p === "/emptydir") return { isDirectory: () => true } as ReturnType<typeof statSync>;
        throw new Error("ENOENT");
      });

      await runCli(["node", "cli.js", "/emptydir"]);

      expect(errorSpy).toHaveBeenCalledWith(
        "No PDF files found matching the input pattern.",
      );
      expect(process.exitCode).toBe(1);
    });

    it("directory + file argument mixed inputs", async () => {
      mocks.globMock.mockImplementation((pattern: string) => {
        if (pattern === "/mydir/**/*.pdf")
          return Promise.resolve(["/mydir/a.pdf"]);
        if (pattern === "/extra.pdf") return Promise.resolve(["/extra.pdf"]);
        return Promise.resolve([]);
      });
      mocks.statSyncMock.mockImplementation((p: string) => {
        if (p === "/mydir") return { isDirectory: () => true } as ReturnType<typeof statSync>;
        throw new Error("ENOENT");
      });

      await runCli(["node", "cli.js", "/mydir", "/extra.pdf"]);

      const calls = mocks.pipelineInstances[0].convert.mock.calls.map(
        (c: unknown[]) => (c[0] as ConversionOptionsLike).inputPath,
      );
      expect(calls).toEqual(["/mydir/a.pdf", "/extra.pdf"]);
    });
  });

  describe("output path with multiple inputs", () => {
    it("directory + --output directory mirrors structure", async () => {
      mocks.globMock.mockImplementation((pattern: string) => {
        if (pattern === "/src/**/*.pdf")
          return Promise.resolve([
            "/src/top.pdf",
            "/src/sub/nested.pdf",
          ]);
        return Promise.resolve([]);
      });
      mocks.statSyncMock.mockImplementation((p: string) => {
        if (p === "/src") return { isDirectory: () => true } as ReturnType<typeof statSync>;
        if (p === "/out") return { isDirectory: () => true } as ReturnType<typeof statSync>;
        throw new Error("ENOENT");
      });

      await runCli(["node", "cli.js", "--output", "/out", "/src"]);

      expect(mocks.pipelineInstances[0].convert).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          inputPath: "/src/top.pdf",
          outputPath: "/out/top_searchable.pdf",
        }),
      );
      expect(mocks.pipelineInstances[0].convert).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          inputPath: "/src/sub/nested.pdf",
          outputPath: "/out/sub/nested_searchable.pdf",
        }),
      );
    });

    it("multiple files + --output directory", async () => {
      mocks.globMock.mockImplementation((pattern: string) => {
        if (pattern === "/docs/a.pdf") return Promise.resolve(["/docs/a.pdf"]);
        if (pattern === "/docs/b.pdf") return Promise.resolve(["/docs/b.pdf"]);
        return Promise.resolve([]);
      });
      mocks.statSyncMock.mockImplementation((p: string) => {
        if (p === "/out") return { isDirectory: () => true } as ReturnType<typeof statSync>;
        throw new Error("ENOENT");
      });

      await runCli([
        "node",
        "cli.js",
        "--output",
        "/out",
        "/docs/a.pdf",
        "/docs/b.pdf",
      ]);

      expect(mocks.pipelineInstances[0].convert).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          inputPath: "/docs/a.pdf",
          outputPath: "/out/a_searchable.pdf",
        }),
      );
      expect(mocks.pipelineInstances[0].convert).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          inputPath: "/docs/b.pdf",
          outputPath: "/out/b_searchable.pdf",
        }),
      );
    });

    it("multiple inputs + --output existing file path -> error", async () => {
      const errorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);

      mocks.globMock.mockImplementation((pattern: string) => {
        if (pattern === "/docs/a.pdf") return Promise.resolve(["/docs/a.pdf"]);
        if (pattern === "/docs/b.pdf") return Promise.resolve(["/docs/b.pdf"]);
        return Promise.resolve([]);
      });
      mocks.statSyncMock.mockImplementation((p: string) => {
        if (p === "/out/result.pdf")
          return { isDirectory: () => false } as ReturnType<typeof statSync>;
        throw new Error("ENOENT");
      });

      await runCli([
        "node",
        "cli.js",
        "--output",
        "/out/result.pdf",
        "/docs/a.pdf",
        "/docs/b.pdf",
      ]);

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("--output"),
      );
      expect(process.exitCode).toBe(1);
      expect(ConversionPipeline).not.toHaveBeenCalled();
    });

    it("multiple inputs + --output non-existent file path -> error", async () => {
      const errorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);

      mocks.globMock.mockImplementation((pattern: string) => {
        if (pattern === "/docs/a.pdf") return Promise.resolve(["/docs/a.pdf"]);
        if (pattern === "/docs/b.pdf") return Promise.resolve(["/docs/b.pdf"]);
        return Promise.resolve([]);
      });
      mocks.statSyncMock.mockImplementation(() => {
        throw new Error("ENOENT");
      });

      await runCli([
        "node",
        "cli.js",
        "--output",
        "/out/result.pdf",
        "/docs/a.pdf",
        "/docs/b.pdf",
      ]);

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("--output"),
      );
      expect(process.exitCode).toBe(1);
      expect(ConversionPipeline).not.toHaveBeenCalled();
    });

    it("single input + --output file path works as before", async () => {
      mocks.globMock.mockResolvedValue(["/docs/input.pdf"]);

      await runCli([
        "node",
        "cli.js",
        "--output",
        "/out/searchable.pdf",
        "/docs/input.pdf",
      ]);

      expect(mocks.pipelineInstances[0].convert).toHaveBeenCalledWith(
        expect.objectContaining({
          inputPath: "/docs/input.pdf",
          outputPath: "/out/searchable.pdf",
        }),
      );
    });
  });

  it("logs verified pages report when ocrVerification is present (complete)", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    mocks.globMock.mockResolvedValue(["/docs/input.pdf"]);
    mocks.state.convertImplementation = vi.fn(
      async (options: ConversionOptionsLike) => ({
        inputPath: options.inputPath,
        outputPath: options.inputPath.replace(/\.pdf$/i, "_searchable.pdf"),
        pageCount: 5,
        textSize: 12000,
        kind: "image_only",
        pagesMadeSearchable: 3,
        ocrVerification: { totalPages: 5, ocrTargetPages: 3, verifiedPages: 3 },
      }),
    );

    await runCli(["node", "cli.js", "/docs/input.pdf"]);

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("3/3 pages verified (OK), total 5 pages"),
    );
  });

 it("exits non-zero when failedPageIndices is present in verification", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    mocks.globMock.mockResolvedValue(["/docs/input.pdf"]);
    mocks.state.convertImplementation = vi.fn(
      async (options: ConversionOptionsLike) => ({
        inputPath: options.inputPath,
        outputPath: options.inputPath.replace(/\.pdf$/i, "_searchable.pdf"),
        pageCount: 5,
        textSize: 12000,
        kind: "image_only",
        pagesMadeSearchable: 4,
        ocrVerification: {
          totalPages: 5,
          ocrTargetPages: 5,
          verifiedPages: 4,
          failedPageIndices: [2],
        },
      }),
    );

    await runCli(["node", "cli.js", "/docs/input.pdf"]);

    expect(process.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("could not be OCR'd"),
    );
  });

  it("logs INCOMPLETE when verifiedPages < ocrTargetPages", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    mocks.globMock.mockResolvedValue(["/docs/input.pdf"]);
    mocks.state.convertImplementation = vi.fn(
      async (options: ConversionOptionsLike) => ({
        inputPath: options.inputPath,
        outputPath: options.inputPath.replace(/\.pdf$/i, "_searchable.pdf"),
        pageCount: 5,
        textSize: 12000,
        kind: "image_only",
        pagesMadeSearchable: 3,
        ocrVerification: { totalPages: 5, ocrTargetPages: 3, verifiedPages: 2 },
      }),
    );

    await runCli(["node", "cli.js", "/docs/input.pdf"]);

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("2/3 pages verified (INCOMPLETE), total 5 pages"),
    );
  });
});

describe("formatOcrReport", () => {
  it("returns pages made searchable without verification", () => {
    const result = formatOcrReport({
      inputPath: "/test.pdf",
      outputPath: "/test_searchable.pdf",
      pageCount: 3,
      textSize: 1000,
      kind: "image_only",
      pagesMadeSearchable: 3,
    });
    expect(result).toBe("3 pages made searchable");
  });

  it("returns OK report when all target pages verified", () => {
    const result = formatOcrReport({
      inputPath: "/test.pdf",
      outputPath: "/test_searchable.pdf",
      pageCount: 5,
      textSize: 1000,
      kind: "image_only",
      pagesMadeSearchable: 3,
      ocrVerification: { totalPages: 5, ocrTargetPages: 3, verifiedPages: 3 },
    });
    expect(result).toBe("3/3 pages verified (OK), total 5 pages");
  });

  it("returns INCOMPLETE report when not all target pages verified", () => {
    const result = formatOcrReport({
      inputPath: "/test.pdf",
      outputPath: "/test_searchable.pdf",
      pageCount: 5,
      textSize: 1000,
      kind: "image_only",
      pagesMadeSearchable: 3,
      ocrVerification: { totalPages: 5, ocrTargetPages: 3, verifiedPages: 1 },
    });
    expect(result).toBe("1/3 pages verified (INCOMPLETE), total 5 pages");
  });
});

describe("handleCliError", () => {
  afterEach(() => {
    process.exitCode = undefined;
  });

  it("sets process.exitCode from error with numeric exitCode property", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    handleCliError({ exitCode: 42 });
    expect(process.exitCode).toBe(42);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("logs error and sets exitCode=1 for non-exitCode errors", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    handleCliError(new Error("boom"));
    expect(process.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("handles string exitCode by logging and setting exitCode=1", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    handleCliError({ exitCode: "bad" });
    expect(process.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("handles null/undefined error", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    handleCliError(null);
    expect(process.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(null);
  });
});
