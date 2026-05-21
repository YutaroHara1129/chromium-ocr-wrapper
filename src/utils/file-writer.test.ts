import { mkdtemp, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
});
