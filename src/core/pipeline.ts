import { dirname, join, extname, basename } from "node:path";
import { stat } from "node:fs/promises";
import type {
  IChromeSearchifyPrinter,
  IPdfInfoExtractor,
  IFileWriter,
  IConversionPipeline,
  ConversionOptions,
  ConversionResult,
} from "../types/index.js";

export class ConversionPipeline implements IConversionPipeline {
  constructor(
    private readonly searchifyPrinter: IChromeSearchifyPrinter,
    private readonly pdfInfoExtractor: IPdfInfoExtractor,
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

    const { pageCount } = await this.pdfInfoExtractor.getMetadataFromFile(
      options.inputPath,
    );

    await this.searchifyPrinter.searchifyToFile(
      options.inputPath,
      outputPath,
      {
        chromePath: options.chromePath,
        verbose: options.verbose,
      },
    );

    const outputStats = await stat(outputPath);

    return {
      inputPath: options.inputPath,
      outputPath,
      pageCount,
      textSize: outputStats.size,
    };
  }

  private generateOutputPath(inputPath: string): string {
    const ext = extname(inputPath);
    const name = basename(inputPath, ext);
    const dir = dirname(inputPath);
    return join(dir, `${name}_searchable${ext}`);
  }
}
