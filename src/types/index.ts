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
  textSize: number;
}

export interface ConversionOptions {
  inputPath: string;
  outputPath?: string;
  overwrite?: boolean;
  verbose?: boolean;
  chromePath?: string;
}

export interface IChromeSearchifyPrinter {
  searchify(
    inputPath: string,
    options?: { chromePath?: string; verbose?: boolean },
  ): Promise<Uint8Array>;
  close(): Promise<void>;
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
