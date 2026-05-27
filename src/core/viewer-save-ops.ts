type SaveUploadResult =
  | { uploaded: true; fileName: string; byteLength: number; saveType: "SEARCHIFIED" }
  | { uploaded: false; reason: string; status?: number };

export type { SaveUploadResult };

export interface SaveAndUploadParams {
  searchifyOk: boolean;
  uploadUrl: string;
  saveTimeoutMs: number;
}

export async function saveAndUpload(
  params: SaveAndUploadParams,
): Promise<SaveUploadResult> {
  const viewer = (globalThis as Record<string, unknown>)["viewer"];
  if (!viewer || typeof viewer !== "object") {
    return { uploaded: false, reason: "NO_VIEWER" };
  }

  const ctrl = (viewer as Record<string, unknown>)["currentController"];
  if (!ctrl || typeof ctrl !== "object") {
    return { uploaded: false, reason: "NO_CONTROLLER" };
  }

  if (!params.searchifyOk) {
    return { uploaded: false, reason: "OCR_INCOMPLETE" };
  }

  const ctrlObj = ctrl as Record<string, unknown>;

  try {
    const result = await Promise.race([
      (ctrlObj["save"] as Function).call(ctrl, "SEARCHIFIED"),
      new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), params.saveTimeoutMs),
      ),
    ]);

    if (result && (result as Record<string, unknown>)["dataToSave"]) {
      const r = result as { dataToSave: ArrayBuffer; fileName: string };
      const blob = new Blob([r.dataToSave], { type: "application/pdf" });
      const response = await fetch(params.uploadUrl, {
        method: "POST",
        headers: { "content-type": "application/pdf" },
        body: blob,
      });

      if (!response.ok) {
        return { uploaded: false, reason: "UPLOAD_FAILED", status: response.status };
      }

      return {
        uploaded: true,
        fileName: r.fileName,
        byteLength: r.dataToSave.byteLength,
        saveType: "SEARCHIFIED",
      };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Browser PDF save/upload failed: ${message}`);
  }

  return { uploaded: false, reason: "NO_DATA" };
}
