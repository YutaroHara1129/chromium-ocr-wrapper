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
  const defaultOriginalResult = {
    dataToSave: new Uint8Array([4, 5, 6]).buffer,
    fileName: "original.pdf",
  };

  const searchified =
    "searchifiedSaveResult" in (options ?? {})
      ? options!.searchifiedSaveResult
      : "saveResult" in (options ?? {})
        ? options!.saveResult
        : defaultSaveResult;

  const original =
    "originalSaveResult" in (options ?? {})
      ? options!.originalSaveResult
      : "saveResult" in (options ?? {})
        ? options!.saveResult
        : defaultOriginalResult;

  const saveMock = vi.fn().mockImplementation((saveType: string) => {
    if (saveType === "SEARCHIFIED") return Promise.resolve(searchified);
    return Promise.resolve(original);
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
      searchifyOk: true,
      uploadUrl: "http://localhost/upload",
      saveTimeoutMs: 5_000,
    });
    expect(result).toEqual({ uploaded: false, reason: "NO_VIEWER" });
  });

  it("returns NO_VIEWER when viewer is not an object", async () => {
    (globalThis as Record<string, unknown>)["viewer"] = "not an object";
    const result = await saveAndUpload({
      searchifyOk: true,
      uploadUrl: "http://localhost/upload",
      saveTimeoutMs: 5_000,
    });
    expect(result).toEqual({ uploaded: false, reason: "NO_VIEWER" });
  });

  it("returns NO_CONTROLLER when currentController is absent", async () => {
    (globalThis as Record<string, unknown>)["viewer"] = {};
    const result = await saveAndUpload({
      searchifyOk: true,
      uploadUrl: "http://localhost/upload",
      saveTimeoutMs: 5_000,
    });
    expect(result).toEqual({ uploaded: false, reason: "NO_CONTROLLER" });
  });

  it("calls save with SEARCHIFIED when searchifyOk is true", async () => {
    const env = setupGlobalViewer();
    cleanup = env.cleanup;
    vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true } as Response);

    const result = await saveAndUpload({
      searchifyOk: true,
      uploadUrl: "http://localhost/upload",
      saveTimeoutMs: 5_000,
    });

    expect(env.saveMock).toHaveBeenCalledWith("SEARCHIFIED");
    expect(result).toEqual({
      uploaded: true,
      fileName: "saved.pdf",
      byteLength: 3,
      saveType: "SEARCHIFIED",
    });
  });

  it("calls save with ORIGINAL when searchifyOk is false", async () => {
    const env = setupGlobalViewer();
    cleanup = env.cleanup;
    vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true } as Response);

    const result = await saveAndUpload({
      searchifyOk: false,
      uploadUrl: "http://localhost/upload",
      saveTimeoutMs: 5_000,
    });

    expect(env.saveMock).toHaveBeenCalledWith("ORIGINAL");
    expect(result).toEqual({
      uploaded: true,
      fileName: "original.pdf",
      byteLength: 3,
      saveType: "ORIGINAL",
    });
  });

  it("falls back to ORIGINAL save when SEARCHIFIED returns null", async () => {
    const env = setupGlobalViewer({
      searchifiedSaveResult: null,
    });
    cleanup = env.cleanup;
    vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true } as Response);

    const result = await saveAndUpload({
      searchifyOk: true,
      uploadUrl: "http://localhost/upload",
      saveTimeoutMs: 5_000,
    });

    expect(env.saveMock).toHaveBeenCalledWith("SEARCHIFIED");
    expect(env.saveMock).toHaveBeenCalledWith("ORIGINAL");
    expect(result).toEqual({
      uploaded: true,
      fileName: "original.pdf",
      byteLength: 3,
      saveType: "ORIGINAL",
    });
  });

  it("returns NO_DATA when both save types return null", async () => {
    const env = setupGlobalViewer({
      searchifiedSaveResult: null,
      originalSaveResult: null,
    });
    cleanup = env.cleanup;

    const result = await saveAndUpload({
      searchifyOk: true,
      uploadUrl: "http://localhost/upload",
      saveTimeoutMs: 5_000,
    });

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
      searchifyOk: true,
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
        searchifyOk: true,
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
      searchifyOk: true,
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

  it("returns NO_DATA when searchifyOk=false and save returns null", async () => {
    const env = setupGlobalViewer({
      saveResult: null,
    });
    cleanup = env.cleanup;

    const result = await saveAndUpload({
      searchifyOk: false,
      uploadUrl: "http://localhost/upload",
      saveTimeoutMs: 5_000,
    });

    expect(result).toEqual({ uploaded: false, reason: "NO_DATA" });
    expect(env.saveMock).toHaveBeenCalledTimes(1);
  });

  it("returns NO_DATA when save result has no dataToSave", async () => {
    const env = setupGlobalViewer({
      saveResult: { fileName: "empty.pdf" } as never,
    });
    cleanup = env.cleanup;

    const result = await saveAndUpload({
      searchifyOk: true,
      uploadUrl: "http://localhost/upload",
      saveTimeoutMs: 5_000,
    });

    expect(result).toEqual({ uploaded: false, reason: "NO_DATA" });
  });
});
