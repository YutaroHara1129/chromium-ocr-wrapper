import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { NodeFileWriter } from "./file-writer.js";

describe("NodeFileWriter", () => {
  let writer: NodeFileWriter;

  beforeEach(() => {
    writer = new NodeFileWriter();
  });

  async function createTempDir(): Promise<string> {
    return mkdtemp(join(tmpdir(), "chromium-ocr-file-writer-"));
  }

  it("writes binary data exactly to file", async () => {
    const tempDir = await createTempDir();

    try {
      const filePath = join(tempDir, "output.bin");
      const data = new Uint8Array([0, 1, 2, 3, 127, 128, 254, 255]);

      await writer.writeFile(filePath, data);

      const written = await readFile(filePath);
      expect(written).toEqual(Buffer.from(data));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("overwrites existing file content", async () => {
    const tempDir = await createTempDir();

    try {
      const filePath = join(tempDir, "output.bin");
      await writeFile(filePath, Buffer.from([10, 20, 30, 40, 50]));

      const replacement = new Uint8Array([1, 2]);

      await writer.writeFile(filePath, replacement);

      const written = await readFile(filePath);
      expect(written).toEqual(Buffer.from(replacement));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("creates directory recursively for nested path", async () => {
    const tempDir = await createTempDir();

    try {
      const nestedDir = join(tempDir, "one", "two", "three");

      await writer.ensureDir(nestedDir);

      const directoryStat = await stat(nestedDir);
      expect(directoryStat.isDirectory()).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("is idempotent when ensuring an existing directory", async () => {
    const tempDir = await createTempDir();

    try {
      const nestedDir = join(tempDir, "existing");
      await writer.ensureDir(nestedDir);

      await expect(writer.ensureDir(nestedDir)).resolves.toBeUndefined();

      const directoryStat = await stat(nestedDir);
      expect(directoryStat.isDirectory()).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("propagates missing parent directory errors from writeFile", async () => {
    const tempDir = await createTempDir();

    try {
      const filePath = join(tempDir, "missing-parent", "output.bin");

      await expect(writer.writeFile(filePath, new Uint8Array([1]))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("propagates permission errors from writeFile", async () => {
    const tempDir = await createTempDir();
    const readOnlyDir = join(tempDir, "read-only");

    try {
      await writer.ensureDir(readOnlyDir);
      await chmod(readOnlyDir, 0o555);

      const filePath = join(readOnlyDir, "output.bin");

      await expect(writer.writeFile(filePath, new Uint8Array([1]))).rejects.toMatchObject({
        code: expect.stringMatching(/^(EACCES|EPERM)$/),
      });
    } finally {
      await chmod(readOnlyDir, 0o755).catch(() => undefined);
      await rm(dirname(readOnlyDir), { recursive: true, force: true });
    }
  });
});
