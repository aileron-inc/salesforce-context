import type { SyncConfig } from "./config";
import { CSV_MIME, JSON_MIME } from "./constants";
import { DriveClient } from "./drive";
import type { SalesforceSyncEnv } from "./env";
import { log } from "./log";

export interface SyncTarget {
  putPart(
    runId: string,
    objectKey: string,
    partName: string,
    body: Uint8Array,
  ): Promise<string>;
  putState(runId: string, state: unknown): Promise<void>;
  getState<T>(runId: string): Promise<T | null>;
  putManifest(manifest: unknown): Promise<void>;
  cleanupOldGenerations(keepCount: number): Promise<void>;
}

export class R2Target implements SyncTarget {
  constructor(private readonly r2: R2Bucket) {}

  async putPart(
    runId: string,
    objectKey: string,
    partName: string,
    body: Uint8Array,
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
      await deleteR2Prefix(this.r2, `generations/${generation}/`);
      log({ message: "generation deleted", generation });
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
    body: Uint8Array,
  ): Promise<string> {
    const folderId = await this.getObjectFolder(runId, objectKey);
    await this.drive.createOrUpdateFile(partName, folderId, body, CSV_MIME);
    return `${runId}/${objectKey}/${partName}`;
  }

  async putState(runId: string, state: unknown): Promise<void> {
    const folderId = await this.getGenerationFolder(runId);
    await this.drive.createOrUpdateFile(
      "_state.json",
      folderId,
      new TextEncoder().encode(JSON.stringify(state, null, 2)),
      JSON_MIME,
    );
  }

  async getState<T>(runId: string): Promise<T | null> {
    const folderId = await this.getGenerationFolder(runId);
    return this.drive.getFileContent<T>("_state.json", folderId);
  }

  async putManifest(manifest: unknown): Promise<void> {
    await this.drive.createOrUpdateFile(
      "manifest.json",
      this.drive.rootFolder,
      new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
      JSON_MIME,
    );
  }

  async cleanupOldGenerations(keepCount: number): Promise<void> {
    const folders = await this.drive.listGenerationFolders();
    const sorted = folders
      .map((folder) => ({ id: folder.id, name: folder.name }))
      .filter((folder) => /^\d{4}-\d{2}-\d{2}-\d{2}$/.test(folder.name))
      .sort((a, b) => a.name.localeCompare(b.name));

    const stale = sorted.slice(0, Math.max(0, sorted.length - keepCount));

    for (const folder of stale) {
      await this.drive.deleteFolder(folder.id);
      log({ message: "generation deleted", generation: folder.name });
    }
  }
}

export function createTarget(
  env: SalesforceSyncEnv,
  syncConfig: SyncConfig,
): SyncTarget {
  if (syncConfig.target === "drive") {
    if (
      !env.GOOGLE_SERVICE_ACCOUNT_EMAIL ||
      !env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY ||
      !syncConfig.drive?.folder_id
    ) {
      throw new Error(
        "drive target requires GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY and sync.config.json drive.folder_id",
      );
    }
    return new DriveTarget(
      new DriveClient(
        env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY,
        syncConfig.drive.folder_id,
      ),
    );
  }

  return new R2Target(env.R2);
}

export async function deleteR2Prefix(
  bucket: R2Bucket,
  prefix: string,
): Promise<void> {
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ prefix, cursor });
    if (listed.objects.length > 0) {
      await bucket.delete(listed.objects.map((object) => object.key));
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}
