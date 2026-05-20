import { createWriteStream } from "node:fs";
import { unlink } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomUUID } from "node:crypto";

function cleanupPartialUpload(tempOutputPath: string): void {
  void unlink(tempOutputPath).catch(() => {
    // Best-effort cleanup only. The stream/request error is propagated through
    // `done`; unlink may fail because the temp file was never created.
    // The rejection is handled here to avoid an unhandled promise rejection.
  });
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
} as const;

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

      const isUploadPath = url.pathname === "/upload";
      const hasValidToken = url.searchParams.get("token") === token;

      if (req.method === "OPTIONS" && isUploadPath && hasValidToken) {
        res.writeHead(204, CORS_HEADERS);
        res.end();
        return;
      }

      if (
        req.method !== "POST" ||
        !isUploadPath ||
        !hasValidToken
      ) {
        res.writeHead(403, CORS_HEADERS);
        res.end("Forbidden");
        return;
      }

      const ws = createWriteStream(tempOutputPath);
      let bytesWritten = 0;

      req.on("data", (chunk: Buffer) => {
        bytesWritten += chunk.length;
      });

      ws.on("error", (err: Error) => {
        cleanupPartialUpload(tempOutputPath);
        res.writeHead(500, CORS_HEADERS);
        res.end("Write error");
        rejectDone(err);
      });

      req.pipe(ws);

      ws.on("finish", () => {
        res.writeHead(200, {
          ...CORS_HEADERS,
          "Content-Type": "text/plain",
        });
        res.end("OK");
        resolveDone(bytesWritten);
      });

      req.on("error", (err: Error) => {
        ws.destroy();
        cleanupPartialUpload(tempOutputPath);
        res.writeHead(500, CORS_HEADERS);
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
