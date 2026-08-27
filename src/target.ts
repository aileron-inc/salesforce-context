import { DriveClient } from "./drive";

export interface SyncTarget {
  putPart(
    runId: string,
    objectKey: string,
    partName: string,
    body: ArrayBuffer,
  ): Promise<string>;
  putState(runId: string, state: unknown): Promise<void>;
  getState<T>(runId: string): Promise<T | null>;
  putManifest(manifest: unknown): Promise<void>;
  cleanupOldGenerations(keepCount: number): Promise<void>;
}

const JSON_MIME = "application/json";
const CSV_MIME = "text/csv";

export class R2Target implements SyncTarget {
  constructor(private readonly r2: R2Bucket) {}

  async putPart(
    runId: string,
    objectKey: string,
    partName: string,
    body: ArrayBuffer,
  ): Promise<string> {
    const path = `generations/${runId}/${objectKey}/${partName}`;
    await this.r2.put(path, body, {
      httpMetadata: { contentType: CSV_MIME },
    });
    return path;
  }

  async putState(runId: string, state: unknown): Promise<void> {
    await this.r2.put(
      `generations/${runId}/_state.json`,
      JSON.stringify(state, null, 2),
      { httpMetadata: { contentType: JSON_MIME } },
    );
  }

  async getState<T>(runId: string): Promise<T | null> {
    const object = await this.r2.get(`generations/${runId}/_state.json`);
    if (!object) {
      return null;
    }
    return object.json<T>();
  }

  async putManifest(manifest: unknown): Promise<void> {
    await this.r2.put("manifest.json", JSON.stringify(manifest, null, 2), {
      httpMetadata: { contentType: JSON_MIME },
    });
  }

  async cleanupOldGenerations(keepCount: number): Promise<void> {
    const generations = new Set<string>();
    let cursor: string | undefined;

    do {
      const listed = await this.r2.list({ prefix: "generations/", cursor });
      for (const object of listed.objects) {
        const generation = object.key.split("/")[1];
        if (generation) {
          generations.add(generation);
        }
      }
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);

    const sorted = [...generations].sort();
    const stale = sorted.slice(0, Math.max(0, sorted.length - keepCount));

    for (const generation of stale) {
      let cursor: string | undefined;

      do {
        const listed = await this.r2.list({
          prefix: `generations/${generation}/`,
          cursor,
        });
        await this.r2.delete(listed.objects.map((object) => object.key));
        cursor = listed.truncated ? listed.cursor : undefined;
      } while (cursor);

      console.log(
        JSON.stringify({ message: "generation deleted", generation }),
      );
    }
  }
}

export class DriveTarget implements SyncTarget {
  private readonly folderCache = new Map<string, string>();

  constructor(private readonly drive: DriveClient) {}

  private async getGenerationFolder(runId: string): Promise<string> {
    const cached = this.folderCache.get(runId);
    if (cached) {
      return cached;
    }
    const folderId = await this.drive.findOrCreateFolder(
      runId,
      this.drive.rootFolder,
    );
    this.folderCache.set(runId, folderId);
    return folderId;
  }

  private async getObjectFolder(
    runId: string,
    objectKey: string,
  ): Promise<string> {
    const cacheKey = `${runId}/${objectKey}`;
    const cached = this.folderCache.get(cacheKey);
    if (cached) {
      return cached;
    }
    const genFolderId = await this.getGenerationFolder(runId);
    const folderId = await this.drive.findOrCreateFolder(objectKey, genFolderId);
    this.folderCache.set(cacheKey, folderId);
    return folderId;
  }

  async putPart(
    runId: string,
    objectKey: string,
    partName: string,
    body: ArrayBuffer,
  ): Promise<string> {
    const folderId = await this.getObjectFolder(runId, objectKey);
    await this.drive.createOrUpdateFile(partName, folderId, body, CSV_MIME);
    return `${runId}/${objectKey}/${partName}`;
  }

  async putState(runId: string, state: unknown): Promise<void> {
    const folderId = await this.getGenerationFolder(runId);
    const body = new TextEncoder().encode(JSON.stringify(state, null, 2));
    await this.drive.createOrUpdateFile(
      "_state.json",
      folderId,
      body.buffer as ArrayBuffer,
      JSON_MIME,
    );
  }

  async getState<T>(runId: string): Promise<T | null> {
    const folderId = await this.getGenerationFolder(runId);
    return this.drive.getFileContent<T>("_state.json", folderId);
  }

  async putManifest(manifest: unknown): Promise<void> {
    const body = new TextEncoder().encode(JSON.stringify(manifest, null, 2));
    await this.drive.createOrUpdateFile(
      "manifest.json",
      this.drive.rootFolder,
      body.buffer as ArrayBuffer,
      JSON_MIME,
    );
  }

  async cleanupOldGenerations(keepCount: number): Promise<void> {
    const folders = await this.drive.listGenerationFolders();
    const sorted = folders
      .map((folder) => ({ id: folder.id, name: folder.name }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const stale = sorted.slice(0, Math.max(0, sorted.length - keepCount));

    for (const folder of stale) {
      await this.drive.deleteFolder(folder.id);
      console.log(
        JSON.stringify({ message: "generation deleted", generation: folder.name }),
      );
    }
  }
}
