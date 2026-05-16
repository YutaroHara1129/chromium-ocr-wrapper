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

    const pdfBytes = await this.pdfInfoExtractor.readPdfBytes(
      options.inputPath,
    );
    const metadata = await this.pdfInfoExtractor.getMetadata(pdfBytes);

    const searchifiedBytes = await this.searchifyPrinter.searchify(
      options.inputPath,
      {
        chromePath: options.chromePath,
        verbose: options.verbose,
      },
    );

    await this.fileWriter.writeFile(outputPath, searchifiedBytes);

    return {
      inputPath: options.inputPath,
      outputPath,
      pageCount: metadata.pageCount,
      textSize: searchifiedBytes.length,
    };
  }

  private generateOutputPath(inputPath: string): string {
    const ext = extname(inputPath);
    const name = basename(inputPath, ext);
    const dir = dirname(inputPath);
    return join(dir, `${name}_searchable${ext}`);
  }
}
