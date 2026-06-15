/**
 * Generate a small multi-page image-only PDF for investigation testing.
 */
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

async function main() {
  const outDir = join(process.argv[2] ?? ".tmp", "test-small.pdf");
  mkdirSync(outDir.split("/").slice(0, -1).join("/"), { recursive: true });

  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);

  const PAGE_COUNT = 10;

  for (let i = 0; i < PAGE_COUNT; i++) {
    const page = pdf.addPage([400, 600]);

    // Draw filled rectangle as "image" content (no text layer)
    page.drawRectangle({
      x: 20,
      y: 20,
      width: 360,
      height: 560,
      color: rgb(0.95, 0.95, 0.95),
    });

    // Draw some shapes to make it look like content
    page.drawRectangle({
      x: 40,
      y: 500,
      width: 320,
      height: 2,
      color: rgb(0.3, 0.3, 0.3),
    });
    page.drawRectangle({
      x: 40,
      y: 400,
      width: 200,
      height: 2,
      color: rgb(0.3, 0.3, 0.3),
    });
    page.drawCircle({
      x: 200,
      y: 300,
      size: 50,
      color: rgb(0.5, 0.5, 0.5),
    });

    // NOTE: We intentionally do NOT add text - this simulates image-only PDF
    // that would need OCR. Using font var to avoid unused import.
    void font;
  }

  const bytes = await pdf.save();
  writeFileSync(outDir, bytes);
  console.error(`Generated ${PAGE_COUNT}-page image-only PDF: ${outDir} (${bytes.length} bytes)`);
}

main().catch(console.error);
