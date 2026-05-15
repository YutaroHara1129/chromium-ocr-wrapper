import { writeFile, mkdir } from "node:fs/promises";
import type { IFileWriter } from "../types/index.js";

export class NodeFileWriter implements IFileWriter {
  async writeFile(path: string, data: Uint8Array): Promise<void> {
    await writeFile(path, data);
  }

  async ensureDir(path: string): Promise<void> {
    await mkdir(path, { recursive: true });
  }
}
