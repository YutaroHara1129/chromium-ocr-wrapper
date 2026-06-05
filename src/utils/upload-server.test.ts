import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUploadServer } from "./upload-server.js";

async function browserLikePdfUpload(
  url: string,
  body: Buffer,
  origin = "chrome-extension://pdf-viewer",
): Promise<Response> {
  const preflight = await fetch(url, {
    method: "OPTIONS",
    headers: {
      origin,
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type",
    },
  });

  if (!preflight.ok) {
    throw new TypeError(`CORS preflight failed with ${preflight.status}`);
  }

  expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
  expect(
    preflight.headers.get("access-control-allow-methods"),
  ).toContain("POST");
  expect(
    preflight.headers.get("access-control-allow-methods"),
  ).toContain("OPTIONS");
  expect(
    preflight.headers.get("access-control-allow-headers")?.toLowerCase(),
  ).toContain("content-type");

  return fetch(url, {
    method: "POST",
    headers: {
      origin,
      "content-type": "application/pdf",
    },
    body,
  });
}

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
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
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
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
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
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
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
      expect(response.headers.get("access-control-allow-origin")).toBe("*");

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

  it("rejects done promise and cleans up partial file on request error", async () => {
    const outputPath = join(tempDir, "output.pdf");
    const server = await createUploadServer(outputPath, 5_000);

    try {
      const url = new URL(server.url);

      await new Promise<void>((resolve) => {
        const socket = new (require("node:net").Socket)();
        socket.connect(parseInt(url.port!), url.hostname, () => {
          socket.write(
            `POST ${url.pathname}${url.search} HTTP/1.1\r\n` +
            `Host: ${url.hostname}:${url.port}\r\n` +
            `Content-Type: application/pdf\r\n` +
            `Content-Length: 1000\r\n` +
            `\r\n`,
          );
          socket.write(Buffer.alloc(10));
          socket.destroy(new Error("simulated connection drop"));
        });
        socket.on("error", () => {});
        socket.on("close", () => resolve());
      });

      await expect(server.done).rejects.toThrow();
      await expect(stat(outputPath)).rejects.toThrow();
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

  it("handles browser CORS preflight before PDF upload", async () => {
    const outputPath = join(tempDir, "output.pdf");
    const server = await createUploadServer(outputPath, 5_000);

    try {
      const body = Buffer.from("PDF-binary-content");

      const response = await browserLikePdfUpload(server.url, body);

      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      expect(await response.text()).toBe("OK");

      await expect(server.done).resolves.toBe(body.length);
      await expect(readFile(outputPath)).resolves.toEqual(body);
    } finally {
      await server.close();
    }
  });

  it("includes CORS headers on rejected preflight requests", async () => {
    const outputPath = join(tempDir, "output.pdf");
    const server = await createUploadServer(outputPath, 5_000);

    try {
      const badUrl = new URL(server.url);
      badUrl.searchParams.set("token", "wrong-token");

      const response = await fetch(badUrl.toString(), {
        method: "OPTIONS",
        headers: {
          origin: "chrome-extension://pdf-viewer",
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type",
        },
      });

      expect(response.status).toBe(403);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      expect(
        response.headers.get("access-control-allow-methods"),
      ).toContain("OPTIONS");
      expect(
        response.headers.get("access-control-allow-headers")?.toLowerCase(),
      ).toContain("content-type");
    } finally {
      await server.close();
    }
  });
});
