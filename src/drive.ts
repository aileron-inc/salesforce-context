interface DriveTokenResponse {
  access_token: string;
  expires_in: number;
}

interface DriveFile {
  id: string;
  name: string;
}

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

    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: jwt,
      }),
    });

    if (!response.ok) {
      throw new Error(`Google auth failed: ${response.status}`);
    }

    const data = (await response.json()) as DriveTokenResponse;
    this.accessToken = data.access_token;
    this.tokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;

    return this.accessToken;
  }

  private async authedFetch(
    input: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const token = await this.getAccessToken();
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${token}`);
    return fetch(input, { ...init, headers });
  }

  async findOrCreateFolder(
    name: string,
    parentId: string,
  ): Promise<string> {
    const escapedName = name.replace(/'/g, "\\'");
    const listUrl =
      `https://www.googleapis.com/drive/v3/files` +
      `?q='${parentId}' in parents and name='${escapedName}'` +
      ` and mimeType='application/vnd.google-apps.folder' and trashed=false` +
      `&fields=files(id,name)&pageSize=1`;

    const listResponse = await this.authedFetch(listUrl);
    if (!listResponse.ok) {
      throw new Error(`Drive list failed: ${listResponse.status}`);
    }

    const listData = (await listResponse.json()) as { files?: DriveFile[] };
    const existing = listData.files?.[0];
    if (existing) {
      return existing.id;
    }

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
    );

    if (!createResponse.ok) {
      throw new Error(`Drive folder create failed: ${createResponse.status}`);
    }

    const created = (await createResponse.json()) as DriveFile;
    return created.id;
  }

  async findFileId(name: string, parentId: string): Promise<string | null> {
    const escapedName = name.replace(/'/g, "\\'");
    const url =
      `https://www.googleapis.com/drive/v3/files` +
      `?q='${parentId}' in parents and name='${escapedName}' and trashed=false` +
      `&fields=files(id,name)&pageSize=1`;

    const response = await this.authedFetch(url);
    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as { files?: DriveFile[] };
    return data.files?.[0]?.id ?? null;
  }

  async createOrUpdateFile(
    name: string,
    parentId: string,
    body: ArrayBuffer,
    mimeType: string,
  ): Promise<void> {
    const existingId = await this.findFileId(name, parentId);

    const metadata = existingId ? { name } : { name, parents: [parentId] };
    const url = existingId
      ? `https://www.googleapis.com/upload/drive/v3/files/${existingId}?uploadType=multipart&fields=id`
      : "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id";

    const multipart = buildMultipartRelated(metadata, mimeType, body);

    const response = await this.authedFetch(url, {
      method: existingId ? "PATCH" : "POST",
      headers: { "content-type": multipart.contentType },
      body: multipart.body,
    });

    if (!response.ok) {
      throw new Error(`Drive upload failed: ${response.status}`);
    }
  }

  async getFileContent<T>(name: string, parentId: string): Promise<T | null> {
    const fileId = await this.findFileId(name, parentId);
    if (!fileId) {
      return null;
    }

    const response = await this.authedFetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
    );
    if (!response.ok) {
      return null;
    }

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
      );
      if (!response.ok) {
        throw new Error(`Drive list folders failed: ${response.status}`);
      }

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
    await this.authedFetch(
      `https://www.googleapis.com/drive/v3/files/${folderId}`,
      { method: "DELETE" },
    );
  }

  get rootFolder(): string {
    return this.rootFolderId;
  }
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

async function importPrivateKey(
  pem: string,
): Promise<CryptoKey> {
  const normalizedKey = pem.includes("\\n") ? pem.replace(/\\n/g, "\n") : pem;
  return crypto.subtle.importKey(
    "pkcs8",
    pemToDer(normalizedKey),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

function buildMultipartRelated(
  metadata: object,
  mediaType: string,
  mediaBody: ArrayBuffer,
): { contentType: string; body: ArrayBuffer } {
  const boundary = `sfctx-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const encoder = new TextEncoder();

  const preamble = encoder.encode(
    `--${boundary}\r\n` +
      `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
      `${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: ${mediaType}\r\n\r\n`,
  );
  const epilogue = encoder.encode(`\r\n--${boundary}--`);

  const body = new Uint8Array(
    preamble.length + mediaBody.byteLength + epilogue.length,
  );
  body.set(preamble, 0);
  body.set(new Uint8Array(mediaBody), preamble.length);
  body.set(epilogue, preamble.length + mediaBody.byteLength);

  return {
    contentType: `multipart/related; boundary=${boundary}`,
    body: body.buffer,
  };
}
