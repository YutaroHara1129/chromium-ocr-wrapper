/**
 * Generate a multi-page image-only PDF with actual raster images.
 * Chrome's PDFSearchify only OCRs pages containing image objects.
 */
import { PDFDocument } from "pdf-lib";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createCanvas } from "canvas";

async function main() {
  const outDir = process.argv[2] ?? ".tmp";
  const pageArg = parseInt(process.argv[3] ?? "10", 10);
  const PAGE_COUNT = Math.max(1, pageArg);
  mkdirSync(outDir, { recursive: true });

  const pdf = await PDFDocument.create();

  for (let i = 0; i < PAGE_COUNT; i++) {
    // Create a raster image with some "text-like" content
    const canvas = createCanvas(400, 600);
    const ctx = canvas.getContext("2d");

    // White background
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, 400, 600);

    // Draw text as pixels (this is what OCR should detect)
    ctx.fillStyle = "#000000";
    ctx.font = "bold 28px sans-serif";
    ctx.fillText(`Page ${i + 1}`, 30, 50);
    ctx.font = "18px sans-serif";
    ctx.fillText(`This is test image page ${i + 1} of ${PAGE_COUNT}`, 30, 90);
    ctx.fillText("OCR should detect this text", 30, 120);

    // Draw some shapes
    ctx.strokeStyle = "#333333";
    ctx.lineWidth = 2;
    ctx.strokeRect(20, 150, 360, 200);
    ctx.fillStyle = "#666666";
    ctx.fillRect(30, 160, 340, 3);
    ctx.fillRect(30, 200, 200, 3);
    ctx.fillRect(30, 240, 280, 3);

    const pngBytes = canvas.toBuffer("image/png");
    const pngImage = await pdf.embedPng(pngBytes);
    const page = pdf.addPage([400, 600]);
    page.drawImage(pngImage, {
      x: 0,
      y: 0,
      width: 400,
      height: 600,
    });
  }

  const bytes = await pdf.save();
  const outPath = join(outDir, "test-image.pdf");
  writeFileSync(outPath, bytes);
  console.error(
    `Generated ${PAGE_COUNT}-page image-only PDF: ${outPath} (${bytes.length} bytes)`,
  );
}

main().catch(console.error);
