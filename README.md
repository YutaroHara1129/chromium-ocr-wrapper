# chromium-ocr-wrapper

CLI tool that converts image-only PDFs into searchable PDFs using Chrome's built-in OCR. Google Chrome ships an on-device OCR engine called Screen AI that runs automatically inside the PDF viewer when a scanned document is opened. This project wraps that capability so you can invoke it from the command line or from a Node.js program, without relying on cloud services.

> **Stable release** — This package follows [semantic versioning](https://semver.org/). The public API (CLI flags, library exports, and type definitions) is stable as of v1.0.0. Tested on macOS; Linux and Windows support is experimental.

## Requirements

- Node.js 20 or later
- Google Chrome or Chromium installed on the system (Playwright's bundled Chromium does not include the PDF viewer extension)
- Chrome must have downloaded the Screen AI component at least once (this happens automatically during normal browsing on recent Chrome versions)
- Chrome 137 or later is required for `PdfSearchifySave`

The tool auto-detects Chrome at the standard installation paths for macOS, Linux, and Windows. If Chrome is installed elsewhere, pass `--chrome-path`.

## Installation

```sh
npm install chromium-ocr-wrapper
```

The package also works without installation via `npx`:

```sh
npx chromium-ocr-wrapper input.pdf
```

After installation the `chromium-ocr` command is also available:

```sh
chromium-ocr input.pdf
```

## Quick start

```sh
# Convert a single PDF
npx chromium-ocr-wrapper scan.pdf

# Write to a specific path
npx chromium-ocr-wrapper scan.pdf -o searchable.pdf

# Process every PDF in a directory
npx chromium-ocr-wrapper "./documents/*.pdf" -o ./output/
```

By default the output file is placed next to the input with a `_searchable` suffix (`scan.pdf` becomes `scan_searchable.pdf`).

## CLI usage

```
chromium-ocr <input> [options]
```

Arguments and flags are listed below.

| Flag | Description |
|------|-------------|
| `<input>` | Path to a PDF file or a glob pattern |
| `-o, --output <path>` | Output file or directory. When the path points to an existing directory, each output file is placed inside it with the `_searchable` suffix |
| `--chrome-path <path>` | Path to the Chrome or Chromium executable |
| `--overwrite` | Overwrite the output file if it already exists |
| `-v, --verbose` | Print progress details to stderr |
| `-V, --version` | Print the tool version |
| `-h, --help` | Print help text |

When the input is a glob pattern, the tool processes each matched PDF sequentially. A non-zero exit code is set if any file fails.

## Library usage

The package exports its core components so you can integrate the conversion into a larger Node.js application.

```ts
import {
  ChromeSearchifyPrinter,
  ConversionPipeline,
  PdfInfoExtractor,
  NodeFileWriter,
} from "chromium-ocr-wrapper";

const printer = new ChromeSearchifyPrinter();
const pipeline = new ConversionPipeline(
  printer,
  new PdfInfoExtractor(),
  new NodeFileWriter(),
);

try {
  const result = await pipeline.convert({
    inputPath: "/path/to/scan.pdf",
    outputPath: "/path/to/output.pdf",
    chromePath: "/usr/bin/google-chrome",
    verbose: true,
  });
  console.log(`Converted ${result.pageCount} pages, output ${result.textSize} bytes`);
} finally {
  await printer.close();
}
```

All constructor arguments follow dependency-injection interfaces (`IChromeSearchifyPrinter`, `IPdfInfoExtractor`, `IFileWriter`, `IConversionPipeline`) exported from the package, so you can replace any component with a custom implementation.

## How it works

The conversion proceeds through five stages.

1. A temporary Chrome user-profile directory is created and populated with the Screen AI component data copied from the host Chrome installation. This ensures the OCR engine is available even in a fresh profile.

2. Chrome is launched with `--headless=new`, `--remote-debugging-port`, and `--enable-features=PdfSearchify,PdfSearchifySave`. The first flag suppresses download dialogs; the second activates the OCR pipeline inside the PDF viewer; the third enables the save endpoint that returns the searchified document.

3. Playwright connects to Chrome over the Chrome DevTools Protocol (CDP) and opens the input PDF in a new tab. The tool waits for the PDF viewer extension frame, then runs `scrollAllPages` inside the frame to step through every page via `viewport.goToPage()`, triggering OCR on each. A `handlePluginMessage_` interceptor records the `showSearchifyInProgress` progress signals. After scrolling, the polling loop checks `hasSearchifyText_` and the progress interceptor's `done` flag; either being true means OCR is complete.

4. The viewer controller's `save("SEARCHIFIED")` method is called through `page.evaluate`. Before calling save, the `handlePluginMessage_` handler is rebound to preserve the original binding that the plugin relies on. The method returns an `ArrayBuffer` containing the PDF with an invisible text layer overlaid on each page. The bytes are uploaded to a temporary local HTTP server started by the tool, which writes them to disk, avoiding serialization overhead for large files.

5. The resulting file is renamed to the final output path.

The invisible text layer uses PDF text-rendering mode 3 (invisible) and UCS-16BE character encoding. The original page images are preserved exactly as they appeared in the input, making the output a lossless addition of searchability.

## Architecture

```
src/
  types/index.ts                 DI interfaces and shared types
  core/
    chrome-searchify-printer.ts  Chrome + Playwright CDP + save('SEARCHIFIED')
    viewer-ocr-ops.ts            OCR progress interception and page scrolling
    viewer-save-ops.ts           save/upload logic executed in the viewer frame
    pipeline.ts                  Orchestrates the full conversion
  utils/
    pdf-info.ts                  Reads page count via lightweight PDF parsing
    upload-server.ts             Local HTTP server for streaming large PDFs from Chrome
    file-writer.ts               Abstracts fs.writeFile and mkdir
  cli.ts                         Commander-based CLI entry point
  index.ts                       Public library exports
```

Each major class implements a corresponding `I`-prefixed interface from `types/index.ts`. The `ConversionPipeline` accepts injected dependencies and coordinates the read-OCR-write cycle. This design allows unit testing with mock implementations and makes it straightforward to swap out the browser backend or file I/O layer.

## Compatibility and limitations

- macOS is tested. Linux and Windows should work with the same code because the tool auto-detects Chrome at platform-standard paths, but they have not been verified end-to-end.
- Chrome 137 or later is required. Earlier versions do not ship the `PdfSearchifySave` feature. Chrome 138 and newer have the feature enabled by default and no longer accept the flag.
- The Screen AI component must be present on the host machine. If Chrome has never been used to view a PDF on the system, the component may not have been downloaded yet.
- Multi-page PDFs are supported. OCR runs on each page as it is loaded in the viewer.
- PDFs that already contain selectable text pass through unchanged because Chrome's PDF viewer does not trigger OCR on text-bearing pages.

## Development

```sh
npm run build          # Compile TypeScript to dist/ via tsup
npm run typecheck      # Run tsc --noEmit
npm run lint           # Run eslint on src/
npm test               # Unit tests (vitest)
npm run test:e2e       # End-to-end tests (requires system Chrome + Screen AI)
npm run test:coverage  # Coverage report
```

The E2E tests create image-only PDFs with the `canvas` package, convert them through the real pipeline, and verify that the output contains PDF text operators. They run unconditionally against the system Chrome installation and require the Screen AI component to be present. The test matrix covers single-file, multi-file, and directory inputs across image-only, text-only, mixed, and blank content types at both 1-page and 250-page scales.

## Troubleshooting

Chrome/Chromium not found — Install Google Chrome or pass `--chrome-path` with the full path to the executable.

CDP connection timed out — Chrome may have failed to start. Check that no other Chrome debugging session is occupying the same port. Running with `--verbose` prints the chosen port and Chrome's stderr output.

OCR did not complete — The Screen AI component may be missing. Open Chrome normally and visit `chrome://components` to verify that the Screen AI component is listed and up to date. Then retry the conversion.

No PDFs found matching the input pattern — Ensure the glob pattern is quoted on the shell to prevent premature expansion (`"*.pdf"` rather than `*.pdf`).

Save returned no data — The `save("SEARCHIFIED")` call returned no data, which typically indicates that Chrome's PDF viewer did not produce a searchified document. This should not occur for image-only PDFs; file a bug if it does.

## License

Apache-2.0

## Disclaimer

This project is not affiliated with, endorsed by, or sponsored by Google LLC. Chrome and Chromium are trademarks of Google LLC. Users are responsible for ensuring their use of Chrome complies with Google's Terms of Service.
