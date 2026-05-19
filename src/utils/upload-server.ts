import { createWriteStream } from "node:fs";
import { unlink } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomUUID } from "node:crypto";

export type UploadServerResult = {
  url: string;
  done: Promise<number>;
  close: () => Promise<void>;
};

export async function createUploadServer(
  tempOutputPath: string,
  timeoutMs: number,
): Promise<UploadServerResult> {
  const token = randomUUID();

  let resolveDone!: (bytes: number) => void;
  let rejectDone!: (error: Error) => void;

  const done = new Promise<number>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  const server = createServer(
    (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");

      if (
        req.method !== "POST" ||
        url.pathname !== "/upload" ||
        url.searchParams.get("token") !== token
      ) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }

      const ws = createWriteStream(tempOutputPath);
      let bytesWritten = 0;

      req.on("data", (chunk: Buffer) => {
        bytesWritten += chunk.length;
      });

      ws.on("error", (err: Error) => {
        unlink(tempOutputPath).catch(() => {});
        res.writeHead(500);
        res.end("Write error");
        rejectDone(err);
      });

      req.pipe(ws);

      ws.on("finish", () => {
        res.writeHead(200, {
          "Access-Control-Allow-Origin": "*",
          "Content-Type": "text/plain",
        });
        res.end("OK");
        resolveDone(bytesWritten);
      });

      req.on("error", (err: Error) => {
        ws.destroy();
        unlink(tempOutputPath).catch(() => {});
        res.writeHead(500);
        res.end("Request error");
        rejectDone(err);
      });
    },
  );

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}/upload?token=${token}`;

  const timeoutId = setTimeout(() => {
    rejectDone(new Error(`Upload timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  done.then(
    () => clearTimeout(timeoutId),
    () => clearTimeout(timeoutId),
  );

  const close = async (): Promise<void> => {
    clearTimeout(timeoutId);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  return { url, done, close };
}
