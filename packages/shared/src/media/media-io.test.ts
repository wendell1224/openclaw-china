import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  FileSizeLimitError,
  MediaTimeoutError,
  cleanupFileSafe,
  downloadToTempFile,
} from "./media-io.js";

const tempDirs: string[] = [];

async function createTempDir(prefix: string): Promise<string> {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

describe("downloadToTempFile", () => {
  it("downloads HTTP response and stores a temp file", async () => {
    const dir = await createTempDir("shared-media-io-");
    const body = Buffer.from("hello-media", "utf8");
    const fetchFn: typeof globalThis.fetch = async () =>
      new Response(body, {
        status: 200,
        headers: {
          "content-type": "image/png",
          "content-length": String(body.length),
        },
      });

    const result = await downloadToTempFile("https://example.com/a.png", {
      fetch: fetchFn,
      tempDir: dir,
      tempPrefix: "dingtalk-file",
    });

    expect(result.path.startsWith(dir)).toBe(true);
    expect(result.fileName.endsWith(".png")).toBe(true);
    expect(result.size).toBe(body.length);
    expect(result.contentType).toBe("image/png");

    const saved = await fsPromises.readFile(result.path);
    expect(saved.equals(body)).toBe(true);
  });

  it("throws FileSizeLimitError when Content-Length exceeds maxSize", async () => {
    const fetchFn: typeof globalThis.fetch = async () =>
      new Response("too-large", {
        status: 200,
        headers: {
          "content-type": "application/octet-stream",
          "content-length": "1024",
        },
      });

    await expect(
      downloadToTempFile("https://example.com/too-large.bin", {
        fetch: fetchFn,
        maxSize: 100,
      })
    ).rejects.toBeInstanceOf(FileSizeLimitError);
  });

  it("throws MediaTimeoutError on timeout", async () => {
    const fetchFn: typeof globalThis.fetch = async (_url, init) =>
      await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          (err as Error & { name: string }).name = "AbortError";
          reject(err);
        });
      });

    await expect(
      downloadToTempFile("https://example.com/slow.bin", {
        fetch: fetchFn,
        timeout: 10,
      })
    ).rejects.toBeInstanceOf(MediaTimeoutError);
  });
});

describe("cleanupFileSafe", () => {
  it("removes file and ignores missing file", async () => {
    const dir = await createTempDir("shared-media-clean-");
    const filePath = path.join(dir, "a.txt");
    await fsPromises.writeFile(filePath, "x", "utf8");
    expect(fs.existsSync(filePath)).toBe(true);

    await cleanupFileSafe(filePath);
    expect(fs.existsSync(filePath)).toBe(false);

    await expect(cleanupFileSafe(filePath)).resolves.toBeUndefined();
    await expect(cleanupFileSafe(undefined)).resolves.toBeUndefined();
  });
});

