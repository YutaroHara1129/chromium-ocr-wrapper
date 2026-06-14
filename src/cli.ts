import { Command } from "commander";
import { glob, hasMagic, escape } from "glob";
import { resolve, basename, extname, join, dirname, relative, isAbsolute } from "node:path";
import globParent from "glob-parent";
import { statSync } from "node:fs";
import { createRequire } from "node:module";
import { ChromeSearchifyPrinter } from "./core/chrome-searchify-printer.js";
import { PdfInfoExtractor } from "./utils/pdf-info.js";
import { ConversionPipeline } from "./core/pipeline.js";
import { NodeFileWriter } from "./utils/file-writer.js";
import type { ConversionOptions, ConversionResult, OcrProgressCallback } from "./types/index.js";

const require = createRequire(import.meta.url);
const pkgVersion = require("../package.json").version;

type CliFlagDefinition = {
  flags: string;
  description: string;
  hasValue: boolean;
};

export const CLI_FLAGS = [
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
] as const satisfies readonly CliFlagDefinition[];

export async function runCli(argv: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();

  program
    .name("chromium-ocr")
    .description(
      "Convert image-only PDFs to searchable PDFs using Chrome's built-in OCR (PDFSearchify)",
    )
    .version(pkgVersion)
    .argument("[input...]", "Input PDF file path(s), directories, or glob patterns");

  for (const flag of CLI_FLAGS) {
    program.option(flag.flags, flag.description);
  }

  program.action(async (inputs: string[], options: Record<string, unknown>) => {
      if (inputs.length === 0) {
        console.error("error: missing required argument 'input'");
        process.exitCode = 1;
        return;
      }

      const files = await resolveInputFiles(inputs);

      if (files.length === 0) {
        console.error("No PDF files found matching the input pattern.");
        process.exitCode = 1;
        return;
      }

      if (files.length > 1 && options.output) {
        const output = options.output as string;
        let isDir = false;
        try {
          isDir = statSync(output).isDirectory();
        } catch {
          // not existing path → treat as file path
        }
        if (!isDir) {
          console.error(
            `Error: --output file path is not allowed with multiple inputs. Specify a directory instead.`,
          );
          process.exitCode = 1;
          return;
        }
      }

      if (options.output) {
        const outDir = options.output as string;
        let outIsDir = false;
        try {
          outIsDir = statSync(outDir).isDirectory();
        } catch {}
        if (outIsDir) {
          for (const file of files) {
            const rel = relative(file.baseDir, file.absolutePath);
            if (isAbsolute(rel) || rel.startsWith("..")) {
              console.error(
                `Error: resolved input path is outside the output directory: ${file.absolutePath}`,
              );
              process.exitCode = 1;
              return;
            }
          }
        }
      }

      const searchifyPrinter = new ChromeSearchifyPrinter();
      const pdfAnalyzer = new PdfInfoExtractor();
      const fileWriter = new NodeFileWriter();
      const pipeline = new ConversionPipeline(
        searchifyPrinter,
        pdfAnalyzer,
        fileWriter,
      );

      let closed = false;
      const cleanup = async (): Promise<void> => {
        if (closed) return;
        closed = true;
        await searchifyPrinter.close();
      };

      const onSignal = (): void => {
        searchifyPrinter.killProcessGroup();
        process.exitCode = 130;
      };
      process.once("SIGINT", onSignal);
      process.once("SIGTERM", onSignal);

      try {
        for (const file of files) {
          const onOcrProgress: OcrProgressCallback | undefined =
            options.verbose
              ? (event) => {
                  switch (event.type) {
                    case "page-scrolled":
                      process.stderr.write(
                        `\r[scrolling] ${event.pageIndex + 1}/${event.pageCount}`,
                      );
                      break;
                    case "ocr-waiting":
                      process.stderr.write(
                        `\n[ocr] waiting ${event.waitMs}ms for OCR buffer\n`,
                      );
                      break;
                    case "document-completed":
                      process.stderr.write(
                        `[ocr] completed ${event.pageCount} pages\n`,
                      );
                      break;
                    case "ocr-retry":
                      process.stderr.write(
                        `\n[ocr] retry ${event.attempt}/${event.maxRetries}: ${event.verifiedPages}/${event.totalPages} pages verified\n`,
                      );
                      break;
                    case "timeout":
                      process.stderr.write(
                        `[ocr] timeout after ${event.elapsedMs}ms / ${event.timeoutMs}ms\n`,
                      );
                      break;
                  }
                }
              : undefined;

          const conversionOptions: ConversionOptions = {
            inputPath: file.absolutePath,
            outputPath: resolveOutputPath(file, options),
            overwrite: options.overwrite as boolean | undefined,
            verbose: options.verbose as boolean | undefined,
            chromePath: options.chromePath as string | undefined,
            onOcrProgress,
          };

          if (options.verbose) {
            console.log(`Processing: ${file.absolutePath}`);
          }

          try {
            const result = await pipeline.convert(conversionOptions);
            const ocrNote =
              result.kind === "text_only" || result.kind === "blank"
                ? "OCR not needed"
                : formatOcrReport(result);
            console.log(
              `Done: ${result.inputPath} -> ${result.outputPath} (${result.pageCount} pages, ${ocrNote})`,
            );
          } catch (error: unknown) {
            const message =
              error instanceof Error ? error.message : String(error);
            console.error(`Failed: ${file.absolutePath}: ${message}`);
            process.exitCode = 1;
          }
        }
      } finally {
        process.removeListener("SIGINT", onSignal);
        process.removeListener("SIGTERM", onSignal);
        await cleanup();
      }
    });

  await program.parseAsync(argv);
}

type ResolvedFile = {
  absolutePath: string;
  baseDir: string;
};

async function resolveInputFiles(inputs: string[]): Promise<ResolvedFile[]> {
  const seen = new Set<string>();
  const result: ResolvedFile[] = [];

  for (const input of inputs) {
    const absInput = resolve(input);
    // Check existence as a literal path BEFORE consulting hasMagic(). This
    // prevents file/dir names containing glob metacharacters (e.g.
    // "[reports]/Q1.pdf") from being misread as glob patterns.
    let isDir = false;
    let isFile = false;
    try {
      const st = statSync(absInput);
      isDir = st.isDirectory();
      if (!isDir) {
        isFile = st.isFile();
      }
    } catch {
      // not a literal path → treat as glob pattern below
    }

    let globPattern: string;
    let baseDir: string;
    let dotOption = false;

    if (isDir) {
      globPattern = join(escape(absInput, { magicalBraces: true }), "**/*.pdf");
      baseDir = absInput;
      dotOption = true;
    } else if (isFile) {
      // Literal file: register directly so metacharacters in the path are
      // never interpreted as glob pattern syntax.
      if (
        absInput.toLowerCase().endsWith(".pdf") &&
        !seen.has(absInput)
      ) {
        seen.add(absInput);
        result.push({ absolutePath: absInput, baseDir: dirname(absInput) });
      }
      continue;
    } else {
      const hasGlob = hasMagic(input, { magicalBraces: true });
      globPattern = absInput;
      baseDir = hasGlob ? resolve(globParent(absInput)) : dirname(absInput);
    }

    const matches = await glob(globPattern, {
      absolute: true,
      nodir: true,
      dot: dotOption,
    });

    for (const match of matches) {
      if (!match.toLowerCase().endsWith(".pdf")) continue;
      if (seen.has(match)) continue;
      seen.add(match);
      result.push({ absolutePath: match, baseDir });
    }
  }

  return result;
}

function resolveOutputPath(
  file: ResolvedFile,
  options: Record<string, unknown>,
): string | undefined {
  const output = options.output as string | undefined;
  if (!output) return undefined;

  let isDir = false;
  try {
    isDir = statSync(output).isDirectory();
  } catch {
    // output path does not exist, treat as file path
  }

  if (isDir) {
    const rel = relative(file.baseDir, file.absolutePath);
    const name = basename(rel, extname(rel));
    const relDir = dirname(rel);
    return relDir === "."
      ? join(output, `${name}_searchable.pdf`)
      : join(output, relDir, `${name}_searchable.pdf`);
  }

  return resolve(output);
}

export function formatOcrReport(result: ConversionResult): string {
  if (!result.ocrVerification) {
    return `${result.pagesMadeSearchable} pages made searchable`;
  }
  const v = result.ocrVerification;
  const status = v.ocrTargetPages === v.verifiedPages ? "OK" : "INCOMPLETE";
  return `${v.verifiedPages}/${v.ocrTargetPages} pages verified (${status}), total ${v.totalPages} pages`;
}

export function handleCliError(error: unknown): void {
  if (error && typeof error === "object" && "exitCode" in error) {
    const { exitCode } = error as { exitCode?: unknown };

    if (typeof exitCode === "number") {
      process.exitCode = exitCode;
      return;
    }
  }

  console.error(error);
  process.exitCode = 1;
}
