import { Command } from "commander";
import { glob } from "glob";
import { resolve, basename, extname, join } from "node:path";
import { statSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { ChromeSearchifyPrinter } from "./core/chrome-searchify-printer.js";
import { PdfInfoExtractor } from "./utils/pdf-info.js";
import { ConversionPipeline } from "./core/pipeline.js";
import { NodeFileWriter } from "./utils/file-writer.js";
import type { ConversionOptions } from "./types/index.js";

const require = createRequire(import.meta.url);
const pkgVersion = require("../package.json").version;

export async function runCli(argv: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();

  program
    .name("chromium-ocr")
    .description(
      "Convert image-only PDFs to searchable PDFs using Chrome's built-in OCR (PDFSearchify)",
    )
    .version(pkgVersion)
    .argument("<input>", "Input PDF file path or glob pattern")
    .option("-o, --output <path>", "Output file or directory path")
    .option("--chrome-path <path>", "Path to Chrome/Chromium executable")
    .option("--overwrite", "Overwrite existing output files")
    .option("-v, --verbose", "Enable verbose logging")
    .action(async (input: string, options: Record<string, unknown>) => {
      const files = await resolveInputFiles(input);

      if (files.length === 0) {
        console.error("No PDF files found matching the input pattern.");
        process.exitCode = 1;
        return;
      }

      const searchifyPrinter = new ChromeSearchifyPrinter();
      const pdfInfoExtractor = new PdfInfoExtractor();
      const fileWriter = new NodeFileWriter();
      const pipeline = new ConversionPipeline(
        searchifyPrinter,
        pdfInfoExtractor,
        fileWriter,
      );

      let closed = false;
      const cleanup = async (): Promise<void> => {
        if (closed) return;
        closed = true;
        await searchifyPrinter.close();
      };

      const onSigint = (): void => void cleanup();
      const onSigterm = (): void => void cleanup();
      process.once("SIGINT", onSigint);
      process.once("SIGTERM", onSigterm);

      try {
        for (const file of files) {
          const conversionOptions: ConversionOptions = {
            inputPath: file,
            outputPath: resolveOutputPath(file, options),
            overwrite: options.overwrite as boolean | undefined,
            verbose: options.verbose as boolean | undefined,
            chromePath: options.chromePath as string | undefined,
          };

          if (options.verbose) {
            console.log(`Processing: ${file}`);
          }

          try {
            const result = await pipeline.convert(conversionOptions);
            console.log(
              `Done: ${result.inputPath} -> ${result.outputPath} (${result.pageCount} pages, ${result.textSize} bytes)`,
            );
          } catch (error: unknown) {
            const message =
              error instanceof Error ? error.message : String(error);
            console.error(`Failed: ${file}: ${message}`);
            process.exitCode = 1;
          }
        }
      } finally {
        process.removeListener("SIGINT", onSigint);
        process.removeListener("SIGTERM", onSigterm);
        await cleanup();
      }
    });

  await program.parseAsync(argv);
}

async function resolveInputFiles(input: string): Promise<string[]> {
  const matches = await glob(input.includes("*") ? input : input, {
    absolute: true,
    nodir: true,
  });
  return matches.filter((f) => f.toLowerCase().endsWith(".pdf"));
}

function resolveOutputPath(
  inputFile: string,
  options: Record<string, unknown>,
): string | undefined {
  const output = options.output as string | undefined;
  if (!output) return undefined;

  try {
    const s = statSync(output);
    if (s.isDirectory()) {
      const name = basename(inputFile, extname(inputFile));
      return join(output, `${name}_searchable.pdf`);
    }
  } catch {
    // output path does not exist, treat as file path
  }

  return resolve(output);
}

const _isDirectExecution =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;

if (_isDirectExecution) {
  runCli(process.argv).catch((error: unknown) => {
    if (error && typeof error === "object" && "exitCode" in error) {
      const { exitCode } = error as { exitCode?: unknown };

      if (typeof exitCode === "number") {
        process.exitCode = exitCode;
        return;
      }
    }

    console.error(error);
    process.exitCode = 1;
  });
}
