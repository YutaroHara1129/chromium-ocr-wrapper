export interface PdfMetadata {
  pageCount: number;
  pages: PageDimension[];
}

export interface PageDimension {
  width: number;
  height: number;
}

export interface ConversionResult {
  inputPath: string;
  outputPath: string;
  pageCount: number;
}

export interface ConversionOptions {
  inputPath: string;
  outputPath?: string;
  overwrite?: boolean;
  verbose?: boolean;
  chromePath?: string;
}

export interface IChromePdfPrinter {
  printToPdf(inputPath: string, outputPath: string, options?: { chromePath?: string; verbose?: boolean }): Promise<void>;
}

export interface IPdfInfoExtractor {
  getMetadata(pdfBytes: Uint8Array): Promise<PdfMetadata>;
  readPdfBytes(filePath: string): Promise<Uint8Array>;
}

export interface IFileWriter {
  writeFile(path: string, data: Uint8Array): Promise<void>;
  ensureDir(path: string): Promise<void>;
}

export interface IConversionPipeline {
  convert(options: ConversionOptions): Promise<ConversionResult>;
}
