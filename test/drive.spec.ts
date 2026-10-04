import { afterEach, describe, expect, it, vi } from "vitest";

import { DriveClient } from "../src/drive";

describe("DriveClient resumable upload", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete (globalThis as { __SF_RETRY_MS?: number }).__SF_RETRY_MS;
  });

  it("524 のあと再開してアップロードを完了し、失敗時の本文を残す", async () => {
    (globalThis as { __SF_RETRY_MS?: number }).__SF_RETRY_MS = 0;
    const puts: Array<{ range: string | null; size: number }> = [];
    let putCount = 0;
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((message?: unknown) => {
      logs.push(String(message));
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        if (url === "https://oauth2.googleapis.com/token") {
          return Response.json({ access_token: "token", expires_in: 3600 });
        }
        if (url.startsWith("https://www.googleapis.com/drive/v3/files?")) {
          return Response.json({ files: [] });
        }
        if (
          url.startsWith("https://www.googleapis.com/upload/drive/v3/files") &&
          init?.method === "POST"
        ) {
          return new Response("{}", {
            status: 200,
            headers: { Location: "https://upload.example/session" },
          });
        }
        if (url === "https://upload.example/session" && init?.method === "PUT") {
          const headers = new Headers(init.headers);
          const range = headers.get("content-range");
          const body = init.body instanceof Uint8Array ? init.body.byteLength : 0;
          puts.push({ range, size: body });
          putCount += 1;
          if (range === "bytes */8") {
            return new Response(null, { status: 308 });
          }
          if (putCount === 1) {
            return new Response('{"error":"origin timed out"}', { status: 524 });
          }
          return Response.json({ id: "file-1" });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    const client = new DriveClient(
      "sync@example.com",
      await serviceAccountPem(),
      "folder-root",
    );
    await client.createOrUpdateFile(
      "part-0000.csv",
      "parent-1",
      new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
      "text/csv",
    );

    expect(puts.some((put) => put.range === "bytes 0-7/8" && put.size === 8)).toBe(true);
    expect(logs.join("\n")).toContain("524");
    expect(logs.join("\n")).toContain("origin timed out");
  });

  it("接続断のあと再開クエリを経て成功する", async () => {
    (globalThis as { __SF_RETRY_MS?: number }).__SF_RETRY_MS = 0;
    let puts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        if (url === "https://oauth2.googleapis.com/token") {
          return Response.json({ access_token: "token", expires_in: 3600 });
        }
        if (url.startsWith("https://www.googleapis.com/drive/v3/files?")) {
          return Response.json({ files: [] });
        }
        if (url.includes("uploadType=resumable") && init?.method === "POST") {
          return new Response(null, {
            status: 200,
            headers: { Location: "https://upload.example/session" },
          });
        }
        if (url === "https://upload.example/session") {
          const range = new Headers(init?.headers).get("content-range");
          puts += 1;
          if (range === "bytes */4") {
            return new Response(null, {
              status: 308,
              headers: { Range: "bytes=0-1" },
            });
          }
          if (puts === 1) {
            throw new TypeError("Network connection lost.");
          }
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
    await client.createOrUpdateFile(
      "part-0001.csv",
      "parent-1",
      new Uint8Array([9, 8, 7, 6]),
      "text/csv",
    );
  });

  it("4xx は本文を含めて再試行せず失敗する", async () => {
    (globalThis as { __SF_RETRY_MS?: number }).__SF_RETRY_MS = 0;
    let puts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        if (url === "https://oauth2.googleapis.com/token") {
          return Response.json({ access_token: "token", expires_in: 3600 });
        }
        if (url.startsWith("https://www.googleapis.com/drive/v3/files?")) {
          return Response.json({ files: [] });
        }
        if (url.includes("uploadType=resumable")) {
          return new Response(null, {
            status: 200,
            headers: { Location: "https://upload.example/session" },
          });
        }
        if (url === "https://upload.example/session") {
          puts += 1;
          return new Response('{"error":"invalid parent"}', { status: 400 });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    const client = new DriveClient(
      "sync@example.com",
      await serviceAccountPem(),
      "folder-root",
    );
    await expect(
      client.createOrUpdateFile(
        "part-0002.csv",
        "parent-1",
        new Uint8Array([1, 2, 3, 4]),
        "text/csv",
      ),
    ).rejects.toThrow(/Drive upload part-0002\.csv: 400 \{"error":"invalid parent"\}/);
    expect(puts).toBe(1);
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
