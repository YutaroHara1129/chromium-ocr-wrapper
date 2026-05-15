import { dirname, join, extname, basename } from "node:path";
import type {
  IChromePdfPrinter,
  IPdfInfoExtractor,
  IFileWriter,
  IConversionPipeline,
  ConversionOptions,
  ConversionResult,
} from "../types/index.js";

export class ConversionPipeline implements IConversionPipeline {
  constructor(
    private readonly chromePdfPrinter: IChromePdfPrinter,
    private readonly pdfInfoExtractor: IPdfInfoExtractor,
    private readonly fileWriter: IFileWriter,
  ) {}

  async convert(options: ConversionOptions): Promise<ConversionResult> {
    const outputPath =
      options.outputPath ?? this.generateOutputPath(options.inputPath);

    const pdfBytes = await this.pdfInfoExtractor.readPdfBytes(
      options.inputPath,
    );
    const metadata = await this.pdfInfoExtractor.getMetadata(pdfBytes);

    await this.fileWriter.ensureDir(dirname(outputPath));
    await this.chromePdfPrinter.printToPdf(
      options.inputPath,
      outputPath,
      {
        chromePath: options.chromePath,
        verbose: options.verbose,
      },
    );

    return {
      inputPath: options.inputPath,
      outputPath,
      pageCount: metadata.pageCount,
    };
  }

  private generateOutputPath(inputPath: string): string {
    const ext = extname(inputPath);
    const name = basename(inputPath, ext);
    const dir = dirname(inputPath);
    return join(dir, `${name}_searchable${ext}`);
  }
}
