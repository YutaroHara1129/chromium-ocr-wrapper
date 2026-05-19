import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUploadServer } from "./upload-server.js";

describe("createUploadServer", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "upload-server-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it("accepts valid upload and streams to file", async () => {
    const outputPath = join(tempDir, "output.pdf");
    const server = await createUploadServer(outputPath, 5_000);

    try {
      const body = Buffer.from("PDF-binary-content");
      const response = await fetch(server.url, {
        method: "POST",
        headers: { "content-type": "application/pdf" },
        body,
      });

      expect(response.status).toBe(200);
      expect(await response.text()).toBe("OK");
      expect(response.headers.get("access-control-allow-origin")).toBe("*");

      const bytesWritten = await server.done;
      expect(bytesWritten).toBe(body.length);

      const written = await readFile(outputPath);
      expect(written).toEqual(body);
    } finally {
      await server.close();
    }
  });

  it("rejects request with invalid token", async () => {
    const outputPath = join(tempDir, "output.pdf");
    const server = await createUploadServer(outputPath, 5_000);

    try {
      const badUrl = new URL(server.url);
      badUrl.searchParams.set("token", "wrong-token");

      const response = await fetch(badUrl.toString(), {
        method: "POST",
        body: Buffer.from("x"),
      });

      expect(response.status).toBe(403);
      expect(await response.text()).toBe("Forbidden");
    } finally {
      await server.close();
    }
  });

  it("rejects GET requests", async () => {
    const outputPath = join(tempDir, "output.pdf");
    const server = await createUploadServer(outputPath, 5_000);

    try {
      const response = await fetch(server.url, { method: "GET" });

      expect(response.status).toBe(403);
    } finally {
      await server.close();
    }
  });

  it("rejects request to wrong path", async () => {
    const outputPath = join(tempDir, "output.pdf");
    const server = await createUploadServer(outputPath, 5_000);

    try {
      const url = new URL(server.url);
      url.pathname = "/wrong";
      const response = await fetch(url.toString(), {
        method: "POST",
        body: Buffer.from("x"),
      });

      expect(response.status).toBe(403);
    } finally {
      await server.close();
    }
  });

  it("rejects done promise on write error", async () => {
    const badOutputPath = join(tempDir, "missing-dir", "output.pdf");
    const server = await createUploadServer(badOutputPath, 5_000);

    try {
      const response = await fetch(server.url, {
        method: "POST",
        body: Buffer.from("data"),
      });

      expect(response.status).toBe(500);
      expect(await response.text()).toBe("Write error");

      await expect(server.done).rejects.toThrow();
    } finally {
      await server.close();
    }
  });

  it("rejects done promise on timeout", async () => {
    vi.useFakeTimers();

    const outputPath = join(tempDir, "output.pdf");
    const server = await createUploadServer(outputPath, 25);

    try {
      const donePromise = server.done;
      await vi.advanceTimersByTimeAsync(30);
      await expect(donePromise).rejects.toThrow("Upload timed out after 25ms");
    } finally {
      await server.close();
      vi.useRealTimers();
    }
  });

  it("cleans up partial file when write stream errors", async () => {
    const badOutputPath = join(tempDir, "missing-dir", "output.pdf");
    const server = await createUploadServer(badOutputPath, 5_000);

    try {
      const response = await fetch(server.url, {
        method: "POST",
        body: Buffer.from("data"),
      });

      expect(response.status).toBe(500);
      await expect(server.done).rejects.toThrow();
      await expect(stat(badOutputPath)).rejects.toThrow();
    } finally {
      await server.close();
    }
  });

  it("closes listener so subsequent requests fail", async () => {
    const outputPath = join(tempDir, "output.pdf");
    const server = await createUploadServer(outputPath, 5_000);

    await server.close();

    await expect(
      fetch(server.url, { method: "POST", body: Buffer.from("x") }),
    ).rejects.toThrow();
  });
});
