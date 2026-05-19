import { Command } from "commander";
import { glob } from "glob";
import { resolve, basename, extname, join } from "node:path";
import { statSync, realpathSync } from "node:fs";
import { spawn as spawnChild } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { ChromeSearchifyPrinter } from "./core/chrome-searchify-printer.js";
import { PdfInfoExtractor } from "./utils/pdf-info.js";
import { ConversionPipeline } from "./core/pipeline.js";
import { NodeFileWriter } from "./utils/file-writer.js";
import type { ConversionOptions } from "./types/index.js";

const require = createRequire(import.meta.url);
const pkgVersion = require("../package.json").version;

const HEAP_REEXEC_MARKER = "CHROMIUM_OCR_HEAP_REEXEC";

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

function getCurrentMaxOldSpaceMb(): number | undefined {
  const arg = process.execArgv.find((a) =>
    a.startsWith("--max-old-space-size="),
  );
  if (!arg) return undefined;
  const mb = parseInt(arg.split("=")[1] ?? "", 10);
  return Number.isNaN(mb) ? undefined : mb;
}

function recommendedHeapMb(bytes: number): number {
  if (bytes < 50 * 1024 * 1024) return 4096;
  if (bytes < 100 * 1024 * 1024) return 6144;
  if (bytes < 200 * 1024 * 1024) return 8192;
  return 12288;
}

async function resolveLargestInputSize(argv: string[]): Promise<number> {
  const knownFlags = new Set(["-o", "--output", "--chrome-path"]);
  let input: string | undefined;

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg) continue;
    if (knownFlags.has(arg)) {
      i++;
      continue;
    }
    if (arg.startsWith("-")) continue;
    input = arg;
    break;
  }

  if (!input) return 0;

  const files = await resolveInputFiles(input);
  let maxSize = 0;
  for (const f of files) {
    try {
      const s = statSync(f);
      if (s.size > maxSize) maxSize = s.size;
    } catch {
      continue;
    }
  }
  return maxSize;
}

async function maybeReexecWithLargerHeap(argv: string[]): Promise<boolean> {
  if (process.env[HEAP_REEXEC_MARKER] === "1") return false;

  const largestSize = await resolveLargestInputSize(argv);
  if (largestSize === 0) return false;

  const recommended = recommendedHeapMb(largestSize);
  const current = getCurrentMaxOldSpaceMb();

  if (current !== undefined && current >= recommended) return false;

  const child = spawnChild(
    process.execPath,
    [
      `--max-old-space-size=${recommended}`,
      ...process.execArgv.filter(
        (arg) => !arg.startsWith("--max-old-space-size="),
      ),
      realpathSync(argv[1]!),
      ...argv.slice(2),
    ],
    {
      stdio: "inherit",
      env: { ...process.env, [HEAP_REEXEC_MARKER]: "1" },
    },
  );

  return new Promise<boolean>((resolve) => {
    child.on("close", (code) => {
      process.exitCode = code ?? 0;
      resolve(true);
    });
    child.on("error", () => {
      resolve(false);
    });
  });
}

const _isDirectExecution =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;

if (_isDirectExecution) {
  maybeReexecWithLargerHeap(process.argv).then(async (reexeced) => {
    if (reexeced) return;

    try {
      await runCli(process.argv);
    } catch (error: unknown) {
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
  });
}
