import {
  backoffMs,
  errorSnippet,
  fetchWithRetry,
  formatStatus,
  HttpStatusError,
  isRetryableHttpBody,
  readErrorBody,
  shortenDetail,
  throwIfNotOk,
} from "./http";
import { log } from "./log";
import { UPLOAD_CHUNK_BYTES } from "./constants";

interface DriveTokenResponse {
  access_token: string;
  expires_in: number;
}

interface DriveFile {
  id: string;
  name: string;
}

const CHUNK_ATTEMPTS = 5;

export class DriveClient {
  private accessToken: string | null = null;
  private tokenExpiresAt = 0;

  constructor(
    private readonly email: string,
    private readonly privateKey: string,
    private readonly rootFolderId: string,
  ) {}

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt) {
      return this.accessToken;
    }

    const now = Math.floor(Date.now() / 1000);
    const header = { alg: "RS256", typ: "JWT" };
    const payload = {
      iss: this.email,
      scope: "https://www.googleapis.com/auth/drive",
      aud: "https://oauth2.googleapis.com/token",
      exp: now + 3600,
      iat: now,
    };

    const unsignedToken = `${base64urlJson(header)}.${base64urlJson(payload)}`;
    const cryptoKey = await importPrivateKey(this.privateKey);
    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      cryptoKey,
      new TextEncoder().encode(unsignedToken),
    );
    const jwt = `${unsignedToken}.${base64urlBuffer(signature)}`;

    const response = await fetchWithRetry(
      "https://oauth2.googleapis.com/token",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion: jwt,
        }),
      },
      "Google auth",
    );
    await throwIfNotOk(response, "Google auth failed");

    const data = (await response.json()) as DriveTokenResponse;
    this.accessToken = data.access_token;
    this.tokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;
    return this.accessToken;
  }

  private invalidateToken(): void {
    this.accessToken = null;
    this.tokenExpiresAt = 0;
  }

  private async authedFetch(
    input: string,
    init: RequestInit,
    label: string,
  ): Promise<Response> {
    const send = async (): Promise<Response> => {
      const token = await this.getAccessToken();
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${token}`);
      return fetchWithRetry(input, { ...init, headers }, label);
    };

    const response = await send();
    if (response.status !== 401) {
      return response;
    }

    await errorSnippet(response);
    this.invalidateToken();
    return send();
  }

  async findFolder(name: string, parentId: string): Promise<string | null> {
    const escapedName = name.replace(/'/g, "\\'");
    const listUrl =
      `https://www.googleapis.com/drive/v3/files` +
      `?q=${encodeURIComponent(`'${parentId}' in parents and name='${escapedName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`)}` +
      `&fields=files(id,name)&pageSize=1`;

    const listResponse = await this.authedFetch(listUrl, {}, "Drive list");
    await throwIfNotOk(listResponse, "Drive list failed");

    const listData = (await listResponse.json()) as { files?: DriveFile[] };
    return listData.files?.[0]?.id ?? null;
  }

  async createFolder(name: string, parentId: string): Promise<string> {
    const createResponse = await this.authedFetch(
      "https://www.googleapis.com/drive/v3/files",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          parents: [parentId],
          mimeType: "application/vnd.google-apps.folder",
        }),
      },
      "Drive folder create",
    );
    await throwIfNotOk(createResponse, "Drive folder create failed");

    const created = (await createResponse.json()) as DriveFile;
    return created.id;
  }

  async createEmptyFile(
    name: string,
    parentId: string,
    mimeType: string,
  ): Promise<string> {
    const response = await this.authedFetch(
      "https://www.googleapis.com/drive/v3/files",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          parents: [parentId],
          mimeType,
        }),
      },
      "Drive file create",
    );
    await throwIfNotOk(response, "Drive file create failed");
    const created = (await response.json()) as DriveFile;
    return created.id;
  }

  async trash(fileId: string): Promise<void> {
    const response = await this.authedFetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ trashed: true }),
      },
      "Drive trash",
    );
    if (response.status === 404) {
      await errorSnippet(response);
      return;
    }
    await throwIfNotOk(response, "Drive trash failed");
  }

  async fileStatus(fileId: string): Promise<"live" | "missing"> {
    const response = await this.authedFetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,trashed`,
      {},
      "Drive file",
    );
    if (response.status === 404) {
      await errorSnippet(response);
      return "missing";
    }
    await throwIfNotOk(response, "Drive file failed");
    const data = (await response.json()) as { trashed?: boolean };
    return data.trashed ? "missing" : "live";
  }

  async downloadJson<T>(fileId: string): Promise<T | null> {
    const response = await this.authedFetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`,
      {},
      "Drive download",
    );
    if (response.status === 404) {
      await errorSnippet(response);
      return null;
    }
    await throwIfNotOk(response, "Drive download failed");
    return response.json<T>();
  }

  async findFileId(name: string, parentId: string): Promise<string | null> {
    const escapedName = name.replace(/'/g, "\\'");
    const url =
      `https://www.googleapis.com/drive/v3/files` +
      `?q=${encodeURIComponent(`'${parentId}' in parents and name='${escapedName}' and trashed=false`)}` +
      `&fields=files(id,name)&pageSize=1`;

    const response = await this.authedFetch(url, {}, "Drive list");
    await throwIfNotOk(response, "Drive list failed");

    const data = (await response.json()) as { files?: DriveFile[] };
    return data.files?.[0]?.id ?? null;
  }

  async listFiles(parentId: string): Promise<DriveFile[]> {
    const files: DriveFile[] = [];
    let pageToken: string | undefined;

    do {
      const params = new URLSearchParams({
        q: `'${parentId}' in parents and trashed=false`,
        fields: "nextPageToken,files(id,name)",
        pageSize: "200",
      });
      if (pageToken) {
        params.set("pageToken", pageToken);
      }

      const response = await this.authedFetch(
        `https://www.googleapis.com/drive/v3/files?${params}`,
        {},
        "Drive list",
      );
      await throwIfNotOk(response, "Drive list failed");

      const data = (await response.json()) as {
        files?: DriveFile[];
        nextPageToken?: string;
      };
      files.push(...(data.files ?? []));
      pageToken = data.nextPageToken;
    } while (pageToken);

    return files;
  }

  async createOrUpdateFile(
    name: string,
    parentId: string,
    body: Uint8Array,
    mimeType: string,
    options?: { fileId?: string; chunkBytes?: number },
  ): Promise<void> {
    const existingId =
      options?.fileId !== undefined
        ? options.fileId
        : await this.findFileId(name, parentId);
    const sessionUrl = await this.startResumableSession(
      name,
      parentId,
      existingId,
      body.byteLength,
      mimeType,
    );
    await this.uploadResumable(
      sessionUrl,
      body,
      `Drive upload ${name}`,
      options?.chunkBytes ?? UPLOAD_CHUNK_BYTES,
    );
  }

  private async startResumableSession(
    name: string,
    parentId: string,
    existingId: string | null,
    byteLength: number,
    mimeType: string,
  ): Promise<string> {
    const url = existingId
      ? `https://www.googleapis.com/upload/drive/v3/files/${existingId}?uploadType=resumable&fields=id`
      : "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id";
    const metadata = existingId
      ? { name }
      : { name, parents: [parentId] };

    const response = await this.authedFetch(
      url,
      {
        method: existingId ? "PATCH" : "POST",
        redirect: "manual",
        headers: {
          "content-type": "application/json; charset=UTF-8",
          "x-upload-content-type": mimeType,
          "x-upload-content-length": String(byteLength),
        },
        body: JSON.stringify(metadata),
      },
      `Drive upload session ${name}`,
    );

    if (!response.ok && response.status !== 308) {
      const body = await readErrorBody(response);
      const detail = shortenDetail(body);
      const deadSession = response.status === 404 || response.status === 410;
      throw new HttpStatusError(
        formatStatus(`Drive upload session ${name}`, response.status, detail),
        response.status,
        deadSession || isRetryableHttpBody(response.status, body),
      );
    }

    const location = response.headers.get("Location");
    await errorSnippet(response);
    if (!location) {
      throw new HttpStatusError(
        `Drive upload session ${name}: missing Location`,
        response.status,
        true,
      );
    }
    return location;
  }

  private async uploadResumable(
    sessionUrl: string,
    body: Uint8Array,
    label: string,
    chunkBytes: number,
  ): Promise<void> {
    const total = body.byteLength;
    if (total === 0) {
      for (let attempt = 1; attempt <= CHUNK_ATTEMPTS; attempt += 1) {
        const next = await this.putChunk(
          sessionUrl,
          new Uint8Array(0),
          0,
          0,
          label,
        );
        if (next === "done") {
          return;
        }
        if (attempt === CHUNK_ATTEMPTS) {
          throw new HttpStatusError(
            `${label}: empty upload did not complete`,
            0,
            true,
          );
        }
        await scheduler.wait(backoffMs(attempt));
      }
      return;
    }

    let offset = 0;
    let attempt = 0;
    while (offset < total) {
      const size = Math.min(chunkBytes, total - offset);
      const end = offset + size;
      try {
        const next = await this.putChunk(
          sessionUrl,
          body.slice(offset, end),
          offset,
          total,
          label,
        );
        if (next === "done") {
          return;
        }
        if (next <= offset) {
          attempt += 1;
          if (attempt >= CHUNK_ATTEMPTS) {
            throw new HttpStatusError(
              `${label}: upload made no progress at byte ${offset}/${total}`,
              0,
              true,
            );
          }
          const resumed = await this.queryResume(sessionUrl, total, label);
          if (resumed === "done" || resumed >= total) {
            return;
          }
          offset = resumed;
          await scheduler.wait(backoffMs(attempt));
          continue;
        }
        offset = next;
        attempt = 0;
      } catch (error) {
        if (isDeadUploadSession(error)) {
          throw error;
        }
        if (error instanceof HttpStatusError && !error.retryable) {
          throw error;
        }
        attempt += 1;
        log({
          message: "drive upload retry",
          label,
          attempt,
          offset,
          bytes: total,
          error: error instanceof Error ? error.message.slice(0, 300) : "unknown",
        });
        if (attempt >= CHUNK_ATTEMPTS) {
          throw error;
        }
        try {
          const resumed = await this.queryResume(sessionUrl, total, label);
          if (resumed === "done" || resumed >= total) {
            return;
          }
          offset = resumed;
        } catch (resumeError) {
          if (
            isDeadUploadSession(resumeError) ||
            (resumeError instanceof HttpStatusError && !resumeError.retryable)
          ) {
            throw resumeError;
          }
        }
        await scheduler.wait(backoffMs(attempt));
      }
    }
  }

  private async putChunk(
    sessionUrl: string,
    chunk: Uint8Array,
    offset: number,
    total: number,
    label: string,
  ): Promise<number | "done"> {
    const headers = new Headers();
    headers.set("authorization", `Bearer ${await this.getAccessToken()}`);
    if (total === 0) {
      headers.set("content-range", "bytes */0");
    } else {
      headers.set(
        "content-range",
        `bytes ${offset}-${offset + chunk.byteLength - 1}/${total}`,
      );
    }

    let response: Response;
    try {
      response = await fetch(sessionUrl, {
        method: "PUT",
        redirect: "manual",
        headers,
        body: chunk.byteLength > 0 ? chunk : undefined,
        signal: AbortSignal.timeout(60_000),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new HttpStatusError(`${label}: ${message}`, 0, true);
    }

    if (response.status === 401) {
      await errorSnippet(response);
      this.invalidateToken();
      throw new HttpStatusError(`${label}: 401`, 401, true);
    }

    if (response.status === 200 || response.status === 201) {
      await errorSnippet(response);
      return "done";
    }

    if (response.status === 308) {
      const next = offsetAfterRange(response.headers.get("Range"));
      await errorSnippet(response);
      return next ?? offset;
    }

    const body = await readErrorBody(response);
    const detail = shortenDetail(body);
    const deadSession = response.status === 404 || response.status === 410;
    const retryable = deadSession || isRetryableHttpBody(response.status, body);
    log({
      message: "drive upload failed",
      label,
      status: response.status,
      offset,
      bytes: total,
      detail,
    });
    throw new HttpStatusError(
      formatStatus(label, response.status, detail),
      response.status,
      retryable,
    );
  }

  private async queryResume(
    sessionUrl: string,
    total: number,
    label: string,
  ): Promise<number | "done"> {
    const headers = new Headers();
    headers.set("authorization", `Bearer ${await this.getAccessToken()}`);
    headers.set("content-range", `bytes */${total}`);

    let response: Response;
    try {
      response = await fetch(sessionUrl, {
        method: "PUT",
        redirect: "manual",
        headers,
        signal: AbortSignal.timeout(60_000),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new HttpStatusError(`${label}: ${message}`, 0, true);
    }

    if (response.status === 200 || response.status === 201) {
      await errorSnippet(response);
      return "done";
    }
    if (response.status === 308) {
      const next = offsetAfterRange(response.headers.get("Range"));
      await errorSnippet(response);
      return next ?? 0;
    }

    const body = await readErrorBody(response);
    const detail = shortenDetail(body);
    const deadSession = response.status === 404 || response.status === 410;
    throw new HttpStatusError(
      formatStatus(`${label} resume`, response.status, detail),
      response.status,
      deadSession || isRetryableHttpBody(response.status, body),
    );
  }

  async getFileContent<T>(name: string, parentId: string): Promise<T | null> {
    const fileId = await this.findFileId(name, parentId);
    if (!fileId) {
      return null;
    }

    const response = await this.authedFetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
      {},
      "Drive download",
    );
    if (response.status === 404) {
      await errorSnippet(response);
      return null;
    }
    await throwIfNotOk(response, "Drive download failed");
    return response.json<T>();
  }

  async listGenerationFolders(): Promise<DriveFile[]> {
    const folders: DriveFile[] = [];
    let pageToken: string | undefined;

    do {
      const params = new URLSearchParams({
        q: `'${this.rootFolderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
        fields: "nextPageToken,files(id,name)",
        pageSize: "200",
      });
      if (pageToken) {
        params.set("pageToken", pageToken);
      }

      const response = await this.authedFetch(
        `https://www.googleapis.com/drive/v3/files?${params}`,
        {},
        "Drive list folders",
      );
      await throwIfNotOk(response, "Drive list folders failed");

      const data = (await response.json()) as {
        files?: DriveFile[];
        nextPageToken?: string;
      };
      folders.push(...(data.files ?? []));
      pageToken = data.nextPageToken;
    } while (pageToken);

    return folders;
  }

  async deleteFolder(folderId: string): Promise<void> {
    const response = await this.authedFetch(
      `https://www.googleapis.com/drive/v3/files/${folderId}`,
      { method: "DELETE" },
      "Drive delete",
    );
    if (response.status === 204 || response.status === 404) {
      await errorSnippet(response);
      return;
    }
    await throwIfNotOk(response, "Drive delete failed");
  }

  get rootFolder(): string {
    return this.rootFolderId;
  }
}

function isDeadUploadSession(error: unknown): error is HttpStatusError {
  return error instanceof HttpStatusError && (error.status === 404 || error.status === 410);
}

function offsetAfterRange(header: string | null): number | null {
  if (!header) {
    return null;
  }
  const match = /bytes=(\d+)-(\d+)/.exec(header);
  if (!match) {
    return null;
  }
  return Number(match[2]) + 1;
}

function base64urlJson(data: object): string {
  return base64urlBuffer(
    new TextEncoder().encode(JSON.stringify(data)).buffer as ArrayBuffer,
  );
}

function base64urlBuffer(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToDer(pem: string): ArrayBuffer {
  const contents = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s/g, "");
  const binaryString = atob(contents);
  const bytes = new Uint8Array(binaryString.length);
  for (let index = 0; index < binaryString.length; index += 1) {
    bytes[index] = binaryString.charCodeAt(index);
  }
  return bytes.buffer;
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const normalizedKey = pem.includes("\\n") ? pem.replace(/\\n/g, "\n") : pem;
  return crypto.subtle.importKey(
    "pkcs8",
    pemToDer(normalizedKey),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}
