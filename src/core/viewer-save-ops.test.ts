import { afterEach, describe, expect, it, vi } from "vitest";
import { saveAndUpload } from "./viewer-save-ops.js";

function setupGlobalViewer(options?: {
  saveResult?: { dataToSave: ArrayBuffer; fileName: string } | null;
  searchifiedSaveResult?: { dataToSave: ArrayBuffer; fileName: string } | null;
  originalSaveResult?: { dataToSave: ArrayBuffer; fileName: string } | null;
}): {
  viewer: Record<string, unknown>;
  saveMock: ReturnType<typeof vi.fn>;
  cleanup: () => void;
} {
  const originalViewer = (globalThis as Record<string, unknown>)["viewer"];
  const originalFetch = globalThis.fetch;

  const defaultSaveResult = {
    dataToSave: new Uint8Array([1, 2, 3]).buffer,
    fileName: "saved.pdf",
  };

  const searchified =
    "searchifiedSaveResult" in (options ?? {})
      ? options!.searchifiedSaveResult
      : "saveResult" in (options ?? {})
        ? options!.saveResult
        : defaultSaveResult;

  const saveMock = vi.fn().mockImplementation((saveType: string) => {
    if (saveType === "SEARCHIFIED") return Promise.resolve(searchified);
    return Promise.resolve(null);
  });

  const viewer = {
    currentController: {
      save: saveMock,
    },
  };

  (globalThis as Record<string, unknown>)["viewer"] = viewer;

  return {
    viewer,
    saveMock,
    cleanup: () => {
      (globalThis as Record<string, unknown>)["viewer"] = originalViewer;
      globalThis.fetch = originalFetch;
    },
  };
}

describe("saveAndUpload", () => {
  let cleanup: (() => void) | null = null;

  afterEach(() => {
    if (cleanup) {
      cleanup();
      cleanup = null;
    }
    vi.restoreAllMocks();
  });

  it("returns NO_VIEWER when viewer is absent", async () => {
    delete (globalThis as Record<string, unknown>)["viewer"];
    const result = await saveAndUpload({
      uploadUrl: "http://localhost/upload",
      saveTimeoutMs: 5_000,
    });
    expect(result).toEqual({ uploaded: false, reason: "NO_VIEWER" });
  });

  it("returns NO_VIEWER when viewer is not an object", async () => {
    (globalThis as Record<string, unknown>)["viewer"] = "not an object";
    const result = await saveAndUpload({
      uploadUrl: "http://localhost/upload",
      saveTimeoutMs: 5_000,
    });
    expect(result).toEqual({ uploaded: false, reason: "NO_VIEWER" });
  });

  it("returns NO_CONTROLLER when currentController is absent", async () => {
    (globalThis as Record<string, unknown>)["viewer"] = {};
    const result = await saveAndUpload({
      uploadUrl: "http://localhost/upload",
      saveTimeoutMs: 5_000,
    });
    expect(result).toEqual({ uploaded: false, reason: "NO_CONTROLLER" });
  });

  it("uploads SEARCHIFIED data when save succeeds", async () => {
    const env = setupGlobalViewer();
    cleanup = env.cleanup;
    vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true } as Response);

    const result = await saveAndUpload({
      uploadUrl: "http://localhost/upload",
      saveTimeoutMs: 5_000,
    });

    expect(env.saveMock).toHaveBeenCalledWith("SEARCHIFIED");
    expect(env.saveMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      uploaded: true,
      fileName: "saved.pdf",
      byteLength: 3,
      saveType: "SEARCHIFIED",
    });
  });

  it("returns NO_DATA when SEARCHIFIED save returns null without attempting ORIGINAL", async () => {
    const env = setupGlobalViewer({
      searchifiedSaveResult: null,
    });
    cleanup = env.cleanup;

    const result = await saveAndUpload({
      uploadUrl: "http://localhost/upload",
      saveTimeoutMs: 5_000,
    });

    expect(env.saveMock).toHaveBeenCalledWith("SEARCHIFIED");
    expect(env.saveMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ uploaded: false, reason: "NO_DATA" });
  });

  it("returns UPLOAD_FAILED when fetch response is not ok", async () => {
    const env = setupGlobalViewer();
    cleanup = env.cleanup;
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 413,
    } as Response);

    const result = await saveAndUpload({
      uploadUrl: "http://localhost/upload",
      saveTimeoutMs: 5_000,
    });

    expect(result).toEqual({
      uploaded: false,
      reason: "UPLOAD_FAILED",
      status: 413,
    });
  });

  it("throws with descriptive message on fetch network error", async () => {
    const env = setupGlobalViewer();
    cleanup = env.cleanup;
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new TypeError("Failed to fetch"),
    );

    await expect(
      saveAndUpload({
        uploadUrl: "http://localhost/upload",
        saveTimeoutMs: 5_000,
      }),
    ).rejects.toThrow("Browser PDF save/upload failed: Failed to fetch");
  });

  it("sends PDF blob via POST to uploadUrl", async () => {
    const env = setupGlobalViewer();
    cleanup = env.cleanup;
    vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true } as Response);

    await saveAndUpload({
      uploadUrl: "http://localhost:9999/upload?token=abc",
      saveTimeoutMs: 5_000,
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://localhost:9999/upload?token=abc",
      expect.objectContaining({
        method: "POST",
        headers: { "content-type": "application/pdf" },
      }),
    );

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = call[1]?.body as Blob;
    expect(body).toBeInstanceOf(Blob);
  });

  it("throws with descriptive message when save() rejects with Error", async () => {
    const originalViewer = (globalThis as Record<string, unknown>)["viewer"];
    const originalFetch = globalThis.fetch;

    const saveMock = vi.fn().mockRejectedValue(new Error("save crashed"));
    (globalThis as Record<string, unknown>)["viewer"] = {
      currentController: { save: saveMock },
    };

    try {
      await expect(
        saveAndUpload({
          uploadUrl: "http://localhost/upload",
          saveTimeoutMs: 5_000,
        }),
      ).rejects.toThrow("Browser PDF save/upload failed: save crashed");
    } finally {
      (globalThis as Record<string, unknown>)["viewer"] = originalViewer;
      globalThis.fetch = originalFetch;
    }
  });

  it("throws with String(error) when save() rejects with non-Error", async () => {
    const originalViewer = (globalThis as Record<string, unknown>)["viewer"];
    const originalFetch = globalThis.fetch;

    const saveMock = vi.fn().mockRejectedValue("boom");
    (globalThis as Record<string, unknown>)["viewer"] = {
      currentController: { save: saveMock },
    };

    try {
      await expect(
        saveAndUpload({
          uploadUrl: "http://localhost/upload",
          saveTimeoutMs: 5_000,
        }),
      ).rejects.toThrow("Browser PDF save/upload failed: boom");
    } finally {
      (globalThis as Record<string, unknown>)["viewer"] = originalViewer;
      globalThis.fetch = originalFetch;
    }
  });

  it("returns NO_DATA when save result has no dataToSave", async () => {
    const env = setupGlobalViewer({
      saveResult: { fileName: "empty.pdf" } as never,
    });
    cleanup = env.cleanup;

    const result = await saveAndUpload({
      uploadUrl: "http://localhost/upload",
      saveTimeoutMs: 5_000,
    });

    expect(result).toEqual({ uploaded: false, reason: "NO_DATA" });
  });
});
