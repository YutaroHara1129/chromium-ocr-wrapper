export type PdfKind = "text_only" | "blank" | "image_only" | "mixed" | "unknown";

export type OcrProgressEvent =
  | { type: "document-completed"; pageCount: number; elapsedMs: number }
  | { type: "timeout"; timeoutMs: number; elapsedMs: number }
  | { type: "page-scrolled"; pageIndex: number; pageCount: number }
  | { type: "ocr-waiting"; pageCount: number; waitMs: number }
  | { type: "ocr-retry"; attempt: number; maxRetries: number; verifiedPages: number; totalPages: number };

export type OcrProgressCallback = (event: OcrProgressEvent) => void;

export type OcrVerificationResult = {
  totalPages: number;
  ocrTargetPages: number;
  verifiedPages: number;
  pageStatuses?: PageVerificationStatus[];
  failedPageIndices?: number[];
};

export type PageVerificationStatus = "text" | "blank" | "image_without_text" | "unresolved";

export interface PdfMetadata {
  pageCount: number;
}

export interface PdfAnalysis {
  pageCount: number;
  kind: PdfKind;
  hasExtractableText: boolean;
  hasImages: boolean;
  pagesNeedingOcr: number;
}

export interface ConversionResult {
  inputPath: string;
  outputPath: string;
  pageCount: number;
  textSize: number;
  kind: PdfKind;
  pagesMadeSearchable: number;
  ocrVerification?: OcrVerificationResult;
}

export interface ConversionOptions {
  inputPath: string;
  outputPath?: string;
  overwrite?: boolean;
  verbose?: boolean;
  chromePath?: string;
  ocrTimeoutMs?: number;
  onOcrProgress?: OcrProgressCallback;
}

export interface SearchifyToFileOptions {
  chromePath?: string;
  verbose?: boolean;
  saveTimeoutMs?: number;
  uploadTimeoutMs?: number;
  ocrTimeoutMs?: number;
  /**
   * Compatibility option for the temporal re-scroll retry.
   * 0 disables it; any positive value is capped at one retry before local rescue.
   */
  maxRetries?: number;
  chunkSize?: number;
  onOcrProgress?: OcrProgressCallback;
}

export interface IChromeSearchifyPrinter {
  searchifyToFile(
    inputPath: string,
    outputPath: string,
    options?: SearchifyToFileOptions,
  ): Promise<OcrVerificationResult>;

  close(): Promise<void>;
  killProcessGroup(): void;
}

export interface IPdfInfoExtractor {
  getMetadataFromFile(filePath: string): Promise<PdfMetadata>;
}

export interface IPdfAnalyzer {
  analyze(filePath: string): Promise<PdfAnalysis>;
}

export interface IFileWriter {
  ensureDir(path: string): Promise<void>;
}

export interface IConversionPipeline {
  convert(options: ConversionOptions): Promise<ConversionResult>;
}
