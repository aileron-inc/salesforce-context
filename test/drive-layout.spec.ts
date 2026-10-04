import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DriveClient } from "../src/drive";
import {
  readStoredId,
  resolveFileId,
  resolveFolderId,
} from "../src/drive-layout";
import { DriveTarget } from "../src/target";

describe("Drive layout ids", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete (globalThis as { __SF_RETRY_MS?: number }).__SF_RETRY_MS;
  });

  it("同時に作ったフォルダは先に書いた ID だけ残し、負けたフォルダは捨てる", async () => {
    let created = 0;
    const trashed: string[] = [];
    let waiting = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const drive = {
      async findFolder(): Promise<string | null> {
        waiting += 1;
        if (waiting === 2) {
          release();
        }
        await gate;
        return null;
      },
      async createFolder(): Promise<string> {
        created += 1;
        return `folder-${created}`;
      },
      async trash(fileId: string): Promise<void> {
        trashed.push(fileId);
      },
    };
    const key = `drive-layout/spec-folder-${crypto.randomUUID()}/generation.json`;
    const [first, second] = await Promise.all([
      resolveFolderId(env.R2, drive, key, "2026-07-30-17", "root"),
      resolveFolderId(env.R2, drive, key, "2026-07-30-17", "root"),
    ]);

    expect(first).toBe(second);
    expect(created).toBe(2);
    expect(trashed).toEqual([first === "folder-1" ? "folder-2" : "folder-1"]);
    expect(await readStoredId(env.R2, key)).toBe(first);

    const again = await resolveFolderId(env.R2, drive, key, "2026-07-30-17", "root");
    expect(again).toBe(first);
    expect(created).toBe(2);
  });

  it("同時に作った manifest の file ID も先勝ちで、フォルダは検索しない", async () => {
    (globalThis as { __SF_RETRY_MS?: number }).__SF_RETRY_MS = 0;
    let files = 0;
    let lists = 0;
    const trashed: string[] = [];
    const folderQueries: string[] = [];
    const uploadedTo: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        if (url.includes("application/vnd.google-apps.folder")) {
          folderQueries.push(url);
        }
        if (url === "https://oauth2.googleapis.com/token") {
          return Response.json({ access_token: "token", expires_in: 3600 });
        }
        if (url.includes("/drive/v3/files?") && (!init?.method || init.method === "GET")) {
          lists += 1;
          if (lists === 2) {
            release();
          }
          await gate;
          return Response.json({ files: [] });
        }
        if (
          url === "https://www.googleapis.com/drive/v3/files" &&
          init?.method === "POST"
        ) {
          files += 1;
          return Response.json({ id: `file-${files}` });
        }
        if (url.startsWith("https://www.googleapis.com/drive/v3/files/") && init?.method === "PATCH") {
          trashed.push(decodeURIComponent(url.split("/").pop() ?? ""));
          return new Response(null, { status: 200 });
        }
        if (url.includes("uploadType=resumable")) {
          const id = url.split("/files/")[1]?.split("?")[0] ?? "";
          uploadedTo.push(decodeURIComponent(id));
          return new Response(null, {
            status: 200,
            headers: { Location: `https://upload.example/${id}` },
          });
        }
        if (url.startsWith("https://upload.example/")) {
          return new Response(null, { status: 200 });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    const client = new DriveClient(
      "sync@example.com",
      await serviceAccountPem(),
      "folder-root",
    );
    const runId = `2026-04-01-00-${crypto.randomUUID().slice(0, 8)}`;
    const target = new DriveTarget(client, env.R2, runId, {
      generationFolderId: "gen-folder",
      objectFolderId: "object-folder",
    });
    await Promise.all([
      target.putManifest({ generation: runId, objects: {} }),
      target.putManifest({ generation: runId, objects: {} }),
    ]);

    const stored = await readStoredId(env.R2, "drive-layout/manifest.json");
    expect(stored === "file-1" || stored === "file-2").toBe(true);
    expect(trashed).toEqual([stored === "file-1" ? "file-2" : "file-1"]);
    expect(folderQueries).toEqual([]);
    expect(uploadedTo.every((id) => id === stored)).toBe(true);

    uploadedTo.length = 0;
    const before = files;
    await target.putManifest({ generation: runId, objects: {} });
    expect(files).toBe(before);
    expect(uploadedTo).toEqual([stored]);
  });

  it("ファイル ID も先に書いた方を使い、負けたファイルは捨てる", async () => {
    let created = 0;
    const trashed: string[] = [];
    let waiting = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const drive = {
      async findFileId(): Promise<string | null> {
        waiting += 1;
        if (waiting === 2) {
          release();
        }
        await gate;
        return null;
      },
      async createEmptyFile(): Promise<string> {
        created += 1;
        return `file-${created}`;
      },
      async trash(fileId: string): Promise<void> {
        trashed.push(fileId);
      },
    };
    const key = `drive-layout/spec-file-${crypto.randomUUID()}.json`;
    const [first, second] = await Promise.all([
      resolveFileId(env.R2, drive, key, "_state.json", "parent", "application/json"),
      resolveFileId(env.R2, drive, key, "_state.json", "parent", "application/json"),
    ]);
    expect(first).toBe(second);
    expect(trashed).toHaveLength(1);
    expect(trashed[0]).not.toBe(first);
  });
});

async function serviceAccountPem(): Promise<string> {
  const key = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign"],
  )) as CryptoKeyPair;
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", key.privateKey);
  if (!(pkcs8 instanceof ArrayBuffer)) {
    throw new Error("expected pkcs8");
  }
  const bytes = new Uint8Array(pkcs8);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  const encoded = btoa(binary);
  const lines = encoded.match(/.{1,64}/g)?.join("\n") ?? encoded;
  return `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----\n`;
}
