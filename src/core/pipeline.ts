import { dirname, join, extname, basename } from "node:path";
import { copyFile, stat } from "node:fs/promises";
import type {
  IChromeSearchifyPrinter,
  IPdfAnalyzer,
  IFileWriter,
  IConversionPipeline,
  ConversionOptions,
  ConversionResult,
} from "../types/index.js";

export class ConversionPipeline implements IConversionPipeline {
  constructor(
    private readonly searchifyPrinter: IChromeSearchifyPrinter,
    private readonly pdfAnalyzer: IPdfAnalyzer,
    private readonly fileWriter: IFileWriter,
  ) {}

  async convert(options: ConversionOptions): Promise<ConversionResult> {
    const outputPath =
      options.outputPath ?? this.generateOutputPath(options.inputPath);

    await this.fileWriter.ensureDir(dirname(outputPath));

    if (!options.overwrite) {
      try {
        await stat(outputPath);
        throw new Error(
          `Output already exists: ${outputPath}. Use --overwrite to replace.`,
        );
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("Output already")) {
          throw err;
        }
        const errno = err as NodeJS.ErrnoException | undefined;
        if (!errno || errno.code !== "ENOENT") {
          throw err;
        }
      }
    }

    const analysis = await this.pdfAnalyzer.analyze(options.inputPath);

    if (analysis.kind === "unknown") {
      throw new Error("File is not a valid PDF");
    }

    if (analysis.kind === "text_only" || analysis.kind === "blank") {
      await copyFile(options.inputPath, outputPath);
    } else {
      const verification = await this.searchifyPrinter.searchifyToFile(
        options.inputPath,
        outputPath,
        {
          chromePath: options.chromePath,
          verbose: options.verbose,
          onOcrProgress: options.onOcrProgress,
        },
      );

      const outputStats = await stat(outputPath);

      return {
        inputPath: options.inputPath,
        outputPath,
        pageCount: analysis.pageCount,
        textSize: outputStats.size,
        kind: analysis.kind,
        pagesMadeSearchable: verification.verifiedPages,
        ocrVerification: verification,
      };
    }

    const outputStats = await stat(outputPath);

    return {
      inputPath: options.inputPath,
      outputPath,
      pageCount: analysis.pageCount,
      textSize: outputStats.size,
      kind: analysis.kind,
      pagesMadeSearchable: 0,
    };
  }

  private generateOutputPath(inputPath: string): string {
    const ext = extname(inputPath);
    const name = basename(inputPath, ext);
    const dir = dirname(inputPath);
    return join(dir, `${name}_searchable${ext}`);
  }
}
