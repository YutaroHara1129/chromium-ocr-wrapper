type SaveUploadResult =
  | { uploaded: true; fileName: string; byteLength: number; saveType: "SEARCHIFIED" | "ORIGINAL" }
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

  const ctrlObj = ctrl as Record<string, unknown>;

  try {
    const saveType = params.searchifyOk ? "SEARCHIFIED" : "ORIGINAL";
    const result = await Promise.race([
      (ctrlObj["save"] as Function).call(ctrl, saveType),
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
        saveType,
      };
    }

    if (saveType === "SEARCHIFIED") {
      const originalResult = await Promise.race([
        (ctrlObj["save"] as Function).call(ctrl, "ORIGINAL"),
        new Promise<null>((resolve) =>
          setTimeout(() => resolve(null), params.saveTimeoutMs),
        ),
      ]);
      if (originalResult && (originalResult as Record<string, unknown>)["dataToSave"]) {
        const or = originalResult as { dataToSave: ArrayBuffer; fileName: string };
        const blob = new Blob([or.dataToSave], { type: "application/pdf" });
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
          fileName: or.fileName,
          byteLength: or.dataToSave.byteLength,
          saveType: "ORIGINAL",
        };
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Browser PDF save/upload failed: ${message}`);
  }

  return { uploaded: false, reason: "NO_DATA" };
}
