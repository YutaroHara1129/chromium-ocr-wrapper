/**
 * Investigation script: understand Chrome's PDFSearchify OCR coverage internals.
 *
 * Usage:
 *   npx tsx scripts/investigate-searchify-coverage.ts <pdf-path> [--chrome-path <path>]
 *
 * What this script does:
 * 1. Launches Chrome headless with PdfSearchify enabled
 * 2. Opens the PDF and deep-instruments handlePluginMessage_ to log ALL messages
 * 3. Scans viewer/controller/viewport/plugin properties for per-page OCR state
 * 4. Tries multiple navigation strategies (goToPage, scrollTop, scrollIntoView)
 * 5. Saves the PDF and checks per-page OCR text coverage
 */

import { chromium } from "playwright-core";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, cp, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import type { Browser, Frame, Page } from "playwright-core";

interface Args {
  pdfPath: string;
  chromePath: string;
  outputDir: string;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  let pdfPath = "";
  let chromePath =
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  let outputDir = "";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--chrome-path" && i + 1 < args.length) {
      chromePath = args[++i];
    } else if (args[i] === "--output-dir" && i + 1 < args.length) {
      outputDir = args[++i];
    } else if (!args[i]!.startsWith("-")) {
      pdfPath = args[i]!;
    }
  }

  if (!pdfPath) {
    console.error(
      "Usage: npx tsx scripts/investigate-searchify-coverage.ts <pdf-path> [--chrome-path <path>] [--output-dir <dir>]",
    );
    process.exit(1);
  }

  if (!outputDir) {
    outputDir = join(tmpdir(), `investigate-${Date.now()}`);
  }

  return { pdfPath, chromePath, outputDir };
}

async function waitForCdp(port: number): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (resp.ok) return;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Chrome CDP connection timed out");
}

async function waitForViewerFrame(page: Page): Promise<Frame> {
  for (let attempt = 0; attempt < 30; attempt++) {
    const frames = page.frames();
    const viewerFrame = frames[1];
    if (viewerFrame) {
      try {
        const ready = await viewerFrame.evaluate(() => {
          const v = (globalThis as Record<string, unknown>)["viewer"];
          if (!v || typeof v !== "object") return false;
          const ctrl = (v as Record<string, unknown>)["currentController"];
          if (!ctrl) return false;
          const vp = (v as Record<string, unknown>)["viewport_"] as Record<
            string,
            unknown
          > | undefined;
          if (!vp) return false;
          const pageDims = vp["pageDimensions_"] as Array<unknown> | undefined;
          return Array.isArray(pageDims) && pageDims.length > 0;
        });
        if (ready) return viewerFrame;
      } catch {
        // not ready
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("PDF viewer frame not found within 15 seconds");
}

async function main() {
  const { pdfPath, chromePath, outputDir } = parseArgs();

  console.error(`[investigate] PDF: ${pdfPath}`);
  console.error(`[investigate] Chrome: ${chromePath}`);
  console.error(`[investigate] Output: ${outputDir}`);

  // Create output directory
  const { mkdirSync } = await import("node:fs");
  mkdirSync(outputDir, { recursive: true });

  // Setup profile
  const profileDir = await mkdtemp(join(tmpdir(), "investigate-ocr-"));
  const homeDir = process.env.HOME ?? "";
  try {
    await cp(
      `${homeDir}/Library/Application Support/Google/Chrome/screen_ai`,
      `${profileDir}/screen_ai`,
      { recursive: true },
    );
  } catch {
    console.error("[investigate] WARNING: screen_ai copy failed");
  }
  try {
    await cp(
      `${homeDir}/Library/Application Support/Google/Chrome/Local State`,
      `${profileDir}/Local State`,
    );
  } catch {
    console.error("[investigate] WARNING: Local State copy failed");
  }

  const cdpPort = 9222 + Math.floor(Math.random() * 1000);

  const chromeProcess: ChildProcess = spawn(
    chromePath,
    [
      `--remote-debugging-port=${cdpPort}`,
      "--remote-debugging-address=127.0.0.1",
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--enable-features=PdfSearchify,PdfSearchifySave",
      "--disable-gpu",
      "--headless=new",
    ],
    { stdio: ["ignore", "pipe", "pipe"], detached: true },
  );

  let browser: Browser | null = null;
  let page: Page | null = null;

  try {
    await waitForCdp(cdpPort);
    console.error(`[investigate] CDP connected on port ${cdpPort}`);

    browser = await chromium.connectOverCDP(
      `http://127.0.0.1:${cdpPort}`,
      { noDefaults: true },
    );

    const context = browser.contexts()[0]!;
    page = await context.newPage();

    const fileUrl = pathToFileURL(pdfPath).href;
    console.error(`[investigate] Opening: ${fileUrl}`);
    await page.goto(fileUrl, { waitUntil: "load", timeout: 30_000 });

    const viewerFrame = await waitForViewerFrame(page);
    console.error("[investigate] Viewer frame ready");

    // ===================================================================
    // STEP 1: Deep-instrument handlePluginMessage_ and scan properties
    // ===================================================================
    console.error("\n[investigate] === STEP 1: Property scan + message logging ===\n");

    const scanResult = await viewerFrame.evaluate(() => {
      const g = globalThis as Record<string, unknown>;
      const viewer = g["viewer"] as Record<string, unknown> | undefined;
      if (!viewer) return { error: "no viewer" };

      const ctrl = viewer["currentController"] as Record<string, unknown> | undefined;
      if (!ctrl) return { error: "no controller" };

      // Collect all message types seen
      const messageLog: Array<{ time: number; type: string; dataKeys: string[] }> = [];

      // Monkey-patch handlePluginMessage_
      const origHandle = (ctrl["handlePluginMessage_"] as Function).bind(ctrl);
      const startTime = performance.now();
      ctrl["handlePluginMessage_"] = function (msg: unknown) {
        const msgData = (msg as { data?: Record<string, unknown> })?.data;
        if (msgData) {
          const type = String(msgData["type"] ?? "UNKNOWN");
          const dataKeys = Object.keys(msgData).filter((k) => k !== "type");
          messageLog.push({
            time: Math.round(performance.now() - startTime),
            type,
            dataKeys,
          });
        }
        return origHandle(msg);
      };

      // Iterative deep scan of properties (BFS)
      type PropEntry = { path: string; type: string; value: string };
      const result: PropEntry[] = [];
      const queue: Array<{ obj: Record<string, unknown>; prefix: string; depth: number }> = [];

      queue.push({ obj: viewer, prefix: "viewer", depth: 0 });
      queue.push({ obj: ctrl, prefix: "controller", depth: 0 });

      const viewport = viewer["viewport_"] as Record<string, unknown> | undefined;
      if (viewport) queue.push({ obj: viewport, prefix: "viewport_", depth: 0 });

      const plugin = ctrl["plugin_"] as Record<string, unknown> | undefined;
      if (plugin) queue.push({ obj: plugin, prefix: "plugin_", depth: 0 });

      while (queue.length > 0) {
        const item = queue.shift()!;
        if (item.depth > 2) continue;
        try {
          const keys = Object.keys(item.obj);
          for (const key of keys) {
            if (key.startsWith("__") || key === "constructor" || key === "prototype")
              continue;
            try {
              const val = item.obj[key];
              const type = typeof val;
              const path = `${item.prefix}.${key}`;
              if (type === "function") continue;
              if (val === null || val === undefined) {
                result.push({ path, type, value: String(val) });
              } else if (type === "boolean" || type === "number" || type === "string") {
                result.push({ path, type, value: String(val) });
              } else if (Array.isArray(val)) {
                result.push({ path, type: `array[${val.length}]`, value: "" });
                if (item.depth < 1 && val.length > 0 && typeof val[0] === "object" && val[0] !== null) {
                  queue.push({ obj: val[0] as Record<string, unknown>, prefix: `${path}[0]`, depth: item.depth + 1 });
                }
              } else if (type === "object") {
                result.push({ path, type: "object", value: "" });
                if (item.depth < 2) {
                  queue.push({ obj: val as Record<string, unknown>, prefix: path, depth: item.depth + 1 });
                }
              }
            } catch {
              // skip inaccessible property
            }
          }
        } catch {
          // skip
        }
      }

      const viewerProps = result.filter((p) => p.path.startsWith("viewer."));
      const ctrlProps = result.filter((p) => p.path.startsWith("controller."));
      const viewportProps = result.filter((p) => p.path.startsWith("viewport_."));
      const pluginProps = result.filter((p) => p.path.startsWith("plugin_."));

      // Store globally for later retrieval
      g["__investigateMessageLog"] = messageLog;

      return {
        viewerProps,
        ctrlProps,
        viewportProps,
        pluginProps,
        pageCount: (viewer["docLength_"] as number | undefined) ?? 0,
      };
    });

    console.error("[investigate] Property scan results:");
    if ("error" in scanResult) {
      console.error(`[investigate] ERROR: ${scanResult.error}`);
    } else {
      console.error(`[investigate] Page count: ${scanResult.pageCount}`);
      console.error(`\n[investigate] --- Viewer properties (non-function) ---`);
      for (const p of scanResult.viewerProps) {
        if (
          p.path.includes("searchify") ||
          p.path.includes("Searchify") ||
          p.path.includes("ocr") ||
          p.path.includes("Ocr") ||
          p.path.includes("page") ||
          p.path.includes("Page") ||
          p.path.includes("text") ||
          p.path.includes("Text") ||
          p.path.includes("Count") ||
          p.path.includes("progress") ||
          p.path.includes("Progress") ||
          p.value !== ""
        ) {
          console.error(`  ${p.path}: [${p.type}] ${p.value}`);
        }
      }
      console.error(`\n[investigate] --- Controller properties (non-function) ---`);
      for (const p of scanResult.ctrlProps) {
        if (
          p.path.includes("searchify") ||
          p.path.includes("Searchify") ||
          p.path.includes("ocr") ||
          p.path.includes("Ocr") ||
          p.path.includes("page") ||
          p.path.includes("Page") ||
          p.path.includes("text") ||
          p.path.includes("Text") ||
          p.path.includes("Count") ||
          p.path.includes("progress") ||
          p.path.includes("Progress") ||
          p.value !== ""
        ) {
          console.error(`  ${p.path}: [${p.type}] ${p.value}`);
        }
      }
      console.error(`\n[investigate] --- Viewport properties (non-function) ---`);
      for (const p of scanResult.viewportProps) {
        console.error(`  ${p.path}: [${p.type}] ${p.value}`);
      }
      console.error(`\n[investigate] --- Plugin properties ---`);
      for (const p of scanResult.pluginProps) {
        console.error(`  ${p.path}: [${p.type}] ${p.value}`);
      }
    }

    // ===================================================================
    // STEP 2: Investigate scrollContent_ scrolling behavior
    // ===================================================================
    console.error("\n[investigate] === STEP 2: Scroll behavior investigation ===\n");

    const pageCount =
      "pageCount" in scanResult ? scanResult.pageCount : 0;

    if (pageCount === 0) {
      console.error("[investigate] ERROR: pageCount is 0, cannot proceed");
      throw new Error("pageCount is 0");
    }

    // 2a: Inspect scrollContent_ structure
    console.error("[investigate] 2a: scrollContent_ structure...");
    const scInfo = await viewerFrame.evaluate(() => {
      const g = globalThis as Record<string, unknown>;
      const viewer = g["viewer"] as Record<string, unknown> | undefined;
      const vp = viewer?.["viewport_"] as Record<string, unknown> | undefined;
      const sc = vp?.["scrollContent_"] as Record<string, unknown> | undefined;
      if (!sc) return { error: "no scrollContent_" };

      const container = sc["container_"] as HTMLElement | undefined;
      const target = sc["target_"] as HTMLElement | undefined;
      const content = sc["content_"] as HTMLElement | undefined;
      const plugin = sc["plugin_"] as Record<string, unknown> | undefined;

      // Find all scrollable elements in the document
      const scrollables = Array.from(
        document.querySelectorAll("*"),
      ).filter((el) => {
        const style = window.getComputedStyle(el);
        return (
          (style.overflowY === "auto" || style.overflowY === "scroll") &&
          el.scrollHeight > el.clientHeight
        );
      });

      return {
        sc_keys: Object.keys(sc).filter((k) => typeof sc[k] !== "function"),
        scrollTop_: sc["scrollTop_"],
        scrollLeft_: sc["scrollLeft_"],
        height_: sc["height_"],
        width_: sc["width_"],
        container_tag: container?.tagName,
        container_class: container?.className?.toString?.()?.slice(0, 100),
        container_id: container?.id,
        container_scrollHeight: container?.scrollHeight,
        container_clientHeight: container?.clientHeight,
        container_scrollTop: container?.scrollTop,
        target_tag: target?.tagName,
        target_class: target?.className?.toString?.()?.slice(0, 100),
        target_scrollHeight: target?.scrollHeight,
        content_tag: content?.tagName,
        content_class: content?.className?.toString?.()?.slice(0, 100),
        plugin_type: plugin ? typeof plugin : undefined,
        scrollablesInDOM: scrollables.map((el) => ({
          tag: el.tagName,
          class: el.className?.toString?.()?.slice(0, 80),
          id: el.id,
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
          scrollTop: el.scrollTop,
        })),
      };
    });
    console.error(`  ${JSON.stringify(scInfo, null, 2)}`);

    // 2b: goToPage then check scrollContent_.scrollTop_
    console.error("\n[investigate] 2b: goToPage → check scrollContent_.scrollTop_...");
    const testPages = Array.from(
      new Set([0, 1, Math.floor(pageCount / 2), pageCount - 1]),
    ).filter((p) => p < pageCount);

    for (const idx of testPages) {
      await viewerFrame.evaluate((pageIdx: number) => {
        const g = globalThis as Record<string, unknown>;
        const viewer = g["viewer"] as Record<string, unknown> | undefined;
        const vp = viewer?.["viewport_"] as Record<string, unknown> | undefined;
        if (vp && typeof vp["goToPage"] === "function") {
          (vp["goToPage"] as Function).call(vp, pageIdx);
        }
      }, idx);

      // Wait a bit for scroll to propagate
      await new Promise((r) => setTimeout(r, 500));

      const scrollState = await viewerFrame.evaluate(() => {
        const g = globalThis as Record<string, unknown>;
        const viewer = g["viewer"] as Record<string, unknown> | undefined;
        const vp = viewer?.["viewport_"] as Record<string, unknown> | undefined;
        const sc = vp?.["scrollContent_"] as Record<string, unknown> | undefined;
        const container = sc?.["container_"] as HTMLElement | undefined;

        // Also check for plugin postMessage based scroll
        const plugin = sc?.["plugin_"] as Record<string, unknown> | undefined;

        return {
          sc_scrollTop_: sc?.["scrollTop_"],
          sc_scrollLeft_: sc?.["scrollLeft_"],
          container_scrollTop: container?.scrollTop,
          container_scrollHeight: container?.scrollHeight,
          body_scrollTop: document.body?.scrollTop,
          docEl_scrollTop: document.documentElement?.scrollTop,
        };
      });
      console.error(
        `  goToPage(${idx}): sc.scrollTop_=${scrollState.sc_scrollTop_}, container.scrollTop=${scrollState.container_scrollTop}, container.scrollHeight=${scrollState.container_scrollHeight}`,
      );
    }

    // 2c: Try directly scrolling container_ element
    console.error("\n[investigate] 2c: Direct container_.scrollTop manipulation...");
    for (const idx of testPages) {
      const result = await viewerFrame.evaluate((pageIdx: number) => {
        const g = globalThis as Record<string, unknown>;
        const viewer = g["viewer"] as Record<string, unknown> | undefined;
        const vp = viewer?.["viewport_"] as Record<string, unknown> | undefined;
        const sc = vp?.["scrollContent_"] as Record<string, unknown> | undefined;
        const pageDims = vp?.["pageDimensions_"] as Array<{ height: number; width: number; y?: number }> | undefined;
        const container = sc?.["container_"] as HTMLElement | undefined;

        if (!container || !pageDims) return { error: "missing container or pageDims" };

        // Calculate target scroll position
        let targetY = 0;
        for (let j = 0; j < pageIdx; j++) {
          targetY += Math.round((pageDims[j]?.height ?? 0) * 0.8103) + 9;
        }

        const beforeScroll = container.scrollTop;
        container.scrollTop = targetY;

        return {
          beforeScroll,
          targetY,
          afterScroll: container.scrollTop,
          container_scrollHeight: container.scrollHeight,
          container_clientHeight: container.clientHeight,
        };
      }, idx);

      // Wait for scroll to settle
      await new Promise((r) => setTimeout(r, 500));

      const afterSettle = await viewerFrame.evaluate(() => {
        const g = globalThis as Record<string, unknown>;
        const viewer = g["viewer"] as Record<string, unknown> | undefined;
        const vp = viewer?.["viewport_"] as Record<string, unknown> | undefined;
        const sc = vp?.["scrollContent_"] as Record<string, unknown> | undefined;
        const container = sc?.["container_"] as HTMLElement | undefined;
        return {
          container_scrollTop: container?.scrollTop,
          sc_scrollTop_: sc?.["scrollTop_"],
        };
      });

      console.error(
        `  page(${idx}): ${JSON.stringify(result)}, afterSettle=${JSON.stringify(afterSettle)}`,
      );
    }

    // 2d: Check DOM structure for page elements
    console.error("\n[investigate] 2d: DOM structure scan...");
    const domInfo = await viewerFrame.evaluate(() => {
      const all = document.querySelectorAll("*");
      const embedEls = document.querySelectorAll("embed");
      const bodyHTML = document.body?.innerHTML?.slice(0, 500);

      return {
        totalElements: all.length,
        embedElements: embedEls.length,
        bodyHTML,
        rootChildren: Array.from(document.body?.children ?? []).map((el) => ({
          tag: el.tagName,
          id: el.id,
          class: el.className?.toString?.()?.slice(0, 80),
        })),
      };
    });
    console.error(`  ${JSON.stringify(domInfo, null, 2)}`);

    // ===================================================================
    // STEP 3: Full scroll-all-pages with extended wait, then save
    // ===================================================================
    console.error("\n[investigate] === STEP 3: Full page scroll + save ===\n");

    console.error(`[investigate] Scrolling all ${pageCount} pages...`);
    for (let i = 0; i < pageCount; i++) {
      await viewerFrame.evaluate((idx: number) => {
        const g = globalThis as Record<string, unknown>;
        const viewer = g["viewer"] as Record<string, unknown> | undefined;
        const vp = viewer?.["viewport_"] as Record<string, unknown> | undefined;
        if (vp && typeof vp["goToPage"] === "function") {
          (vp["goToPage"] as Function).call(vp, idx);
        }
      }, i);

      if (i % 20 === 0) {
        console.error(`  goToPage(${i}/${pageCount})`);
      }
      await new Promise((r) => setTimeout(r, 300));
    }

    // Extended wait for OCR to complete
    const waitMs = Math.max(pageCount * 200, 30_000);
    console.error(`[investigate] Waiting ${waitMs}ms for OCR to complete...`);
    await new Promise((r) => setTimeout(r, waitMs));

    // Collect message log
    const finalMessages = await viewerFrame.evaluate(() => {
      const g = globalThis as Record<string, unknown>;
      const log = g["__investigateMessageLog"] as Array<{
        time: number;
        type: string;
        dataKeys: string[];
      }> | undefined;
      return log ?? [];
    });

    // Summarize message types
    const typeCounts: Record<string, number> = {};
    for (const m of finalMessages) {
      typeCounts[m.type] = (typeCounts[m.type] ?? 0) + 1;
    }
    console.error(`\n[investigate] === Message type summary (${finalMessages.length} total) ===`);
    for (const [type, count] of Object.entries(typeCounts).sort((a, b) => b[1]! - a[1]!)) {
      console.error(`  ${type}: ${count}`);
    }

    // Show unique message types with their dataKeys
    const seenTypes = new Set<string>();
    console.error(`\n[investigate] === Unique message types with dataKeys ===`);
    for (const m of finalMessages) {
      if (!seenTypes.has(m.type)) {
        seenTypes.add(m.type);
        console.error(`  [${m.time}ms] ${m.type}: dataKeys=${JSON.stringify(m.dataKeys)}`);
      }
    }

    // Check final viewer state
    const finalState = await viewerFrame.evaluate(() => {
      const g = globalThis as Record<string, unknown>;
      const viewer = g["viewer"] as Record<string, unknown> | undefined;
      return {
        hasSearchifyText_: viewer?.["hasSearchifyText_"],
        pdfSearchifySaveEnabled_: viewer?.["pdfSearchifySaveEnabled_"],
        docLength_: viewer?.["docLength_"],
      };
    });
    console.error(`\n[investigate] Final viewer state: ${JSON.stringify(finalState)}`);

    // ===================================================================
    // STEP 4: Save and analyze coverage
    // ===================================================================
    console.error("\n[investigate] === STEP 4: Save and verify ===\n");

    const outputPath = join(outputDir, "output.pdf");
    const { createUploadServer } = await import("../src/utils/upload-server.js");
    const uploadServer = await createUploadServer(outputPath, 300_000);

    const saveAndUpload = (await import("../src/core/viewer-save-ops.js")).saveAndUpload;

    const uploadResult = await viewerFrame.evaluate(
      saveAndUpload,
      {
        uploadUrl: uploadServer.url,
        saveTimeoutMs: 300_000,
      },
    );

    console.error(`[investigate] Save result: ${JSON.stringify(uploadResult)}`);

    if (uploadResult.uploaded) {
      await uploadServer.done;
      await uploadServer.close();

      const { verifyPerPageText } = await import("../src/utils/pdf-info.js");
      const { readFile } = await import("node:fs/promises");
      const outputBuffer = await readFile(outputPath);
      const verification = verifyPerPageText(outputBuffer);

      console.error(`\n[investigate] === Verification ===`);
      console.error(`  totalPages: ${verification.totalPages}`);
      console.error(`  ocrTargetPages: ${verification.ocrTargetPages}`);
      console.error(`  verifiedPages: ${verification.verifiedPages}`);

      // Write report
      const report = {
        timestamp: new Date().toISOString(),
        pdfPath,
        pageCount,
        messages: finalMessages,
        typeCounts,
        finalState,
        verification,
        domInfo,
      };
      await writeFile(
        join(outputDir, "report.json"),
        JSON.stringify(report, null, 2),
      );
      console.error(`\n[investigate] Report written to ${join(outputDir, "report.json")}`);
      console.error(`[investigate] Output PDF: ${outputPath}`);
    } else {
      console.error("[investigate] Save failed!");
    }

    await uploadServer.close();

  } finally {
    if (page) {
      try {
        await page.close();
      } catch {
        // ignore
      }
    }
    if (browser) {
      try {
        await browser.close();
      } catch {
        // ignore
      }
    }
    try {
      if (chromeProcess.pid) {
        process.kill(-chromeProcess.pid, "SIGKILL");
      }
    } catch {
      try {
        chromeProcess.kill("SIGKILL");
      } catch {
        // already dead
      }
    }
    await rm(profileDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("[investigate] FATAL:", err);
  process.exit(1);
});
