import { mkdir } from "node:fs/promises";
import type { IFileWriter } from "../types/index.js";

export class NodeFileWriter implements IFileWriter {
  async ensureDir(path: string): Promise<void> {
    await mkdir(path, { recursive: true });
  }
}
