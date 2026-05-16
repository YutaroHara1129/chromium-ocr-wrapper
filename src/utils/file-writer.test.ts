import { describe, it, expect, beforeEach } from "vitest";
import { NodeFileWriter } from "./file-writer.js";

describe("NodeFileWriter", () => {
  let writer: NodeFileWriter;

  beforeEach(() => {
    writer = new NodeFileWriter();
  });

  it("should write file to disk", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const os = await import("node:os");

    const tmpPath = path.join(os.tmpdir(), `test-file-writer-${Date.now()}.bin`);
    const data = new Uint8Array([1, 2, 3, 4, 5]);

    await writer.writeFile(tmpPath, data);

    const read = await fs.readFile(tmpPath);
    expect(read).toEqual(Buffer.from(data));

    await fs.unlink(tmpPath);
  });

  it("should create directory recursively", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const os = await import("node:os");

    const tmpDir = path.join(os.tmpdir(), `test-dir-writer-${Date.now()}`, "nested", "deep");

    await writer.ensureDir(tmpDir);

    const stat = await fs.stat(tmpDir);
    expect(stat.isDirectory()).toBe(true);

    await fs.rm(path.dirname(path.dirname(tmpDir)), { recursive: true });
  });
});
