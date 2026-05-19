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

export interface SearchifyToFileOptions {
  chromePath?: string;
  verbose?: boolean;
  saveTimeoutMs?: number;
  uploadTimeoutMs?: number;
}

export interface IChromeSearchifyPrinter {
  searchifyToFile(
    inputPath: string,
    outputPath: string,
    options?: SearchifyToFileOptions,
  ): Promise<void>;

  close(): Promise<void>;
}

export interface IPdfInfoExtractor {
  getMetadataFromFile(filePath: string): Promise<PdfMetadata>;
}

export interface IFileWriter {
  ensureDir(path: string): Promise<void>;
}

export interface IConversionPipeline {
  convert(options: ConversionOptions): Promise<ConversionResult>;
}
