import { JSON_MIME } from "./constants";
import { log } from "./log";

interface DriveFolderClient {
  findFolder(name: string, parentId: string): Promise<string | null>;
  createFolder(name: string, parentId: string): Promise<string>;
  fileStatus(fileId: string): Promise<"live" | "missing">;
  trash(fileId: string): Promise<void>;
}

interface DriveFileClient {
  findFileId(name: string, parentId: string): Promise<string | null>;
  createEmptyFile(name: string, parentId: string, mimeType: string): Promise<string>;
  fileStatus(fileId: string): Promise<"live" | "missing">;
  trash(fileId: string): Promise<void>;
}

export interface DriveFolders {
  generationFolderId: string;
  objectFolderId: string;
}

interface StoredDriveId {
  id: string;
  etag: string;
}

export function generationFolderKey(runId: string): string {
  return `drive-layout/${runId}/generation.json`;
}

export function objectFolderKey(runId: string, objectKey: string): string {
  return `drive-layout/${runId}/folders/${objectKey}.json`;
}

export function stateFileKey(runId: string): string {
  return `drive-layout/${runId}/files/_state.json`;
}

export function manifestFileKey(): string {
  return `drive-layout/manifest.json`;
}

export function partFileKey(
  runId: string,
  objectKey: string,
  partName: string,
): string {
  return `drive-layout/${runId}/files/${objectKey}/${partName}.json`;
}

export async function readStoredId(
  bucket: R2Bucket,
  key: string,
): Promise<string | null> {
  const stored = await readStoredRecord(bucket, key);
  return stored?.id ?? null;
}

async function readStoredRecord(
  bucket: R2Bucket,
  key: string,
): Promise<StoredDriveId | null> {
  const object = await bucket.get(key);
  if (!object) {
    return null;
  }
  const parsed = await object.json<{ id?: string }>();
  if (!parsed.id) {
    return null;
  }
  return { id: parsed.id, etag: object.etag };
}

export async function claimStoredId(
  bucket: R2Bucket,
  key: string,
  id: string,
): Promise<string> {
  const written = await bucket.put(key, JSON.stringify({ id }), {
    httpMetadata: { contentType: JSON_MIME },
    onlyIf: { etagDoesNotMatch: "*" },
  });
  if (written) {
    return id;
  }

  const winner = await readStoredId(bucket, key);
  if (!winner) {
    throw new Error(`drive id missing after lost claim: ${key}`);
  }
  return winner;
}

export async function resolveFolderId(
  bucket: R2Bucket,
  drive: DriveFolderClient,
  key: string,
  name: string,
  parentId: string,
): Promise<string> {
  return resolveDriveId(bucket, drive, key, name, "folder", async () => {
    const listed = await drive.findFolder(name, parentId);
    const created = listed ? null : await drive.createFolder(name, parentId);
    return { candidate: listed ?? created, created };
  });
}

export async function resolveFileId(
  bucket: R2Bucket,
  drive: DriveFileClient,
  key: string,
  name: string,
  parentId: string,
  mimeType: string,
): Promise<string> {
  return resolveDriveId(bucket, drive, key, name, "file", async () => {
    const listed = await drive.findFileId(name, parentId);
    const created = listed
      ? null
      : await drive.createEmptyFile(name, parentId, mimeType);
    return { candidate: listed ?? created, created };
  });
}

async function resolveDriveId(
  bucket: R2Bucket,
  drive: { fileStatus(fileId: string): Promise<"live" | "missing">; trash(fileId: string): Promise<void> },
  key: string,
  name: string,
  kind: "folder" | "file",
  locate: () => Promise<{ candidate: string | null; created: string | null }>,
): Promise<string> {
  const stored = await readStoredRecord(bucket, key);
  if (stored && (await drive.fileStatus(stored.id)) === "live") {
    return stored.id;
  }
  if (stored) {
    log({ message: "drive id stale", kind, name });
  }

  const located = await locate();
  if (!located.candidate) {
    throw new Error(`drive ${kind} id missing`);
  }

  if (stored) {
    const replaced = await bucket.put(key, JSON.stringify({ id: located.candidate }), {
      httpMetadata: { contentType: JSON_MIME },
      onlyIf: { etagMatches: stored.etag },
    });
    if (replaced) {
      return located.candidate;
    }

    const winner = await readStoredId(bucket, key);
    if (!winner) {
      return claimLocated(bucket, drive, key, name, kind, located);
    }
    if (located.created && located.created !== winner) {
      await drive.trash(located.created);
      log({ message: "drive duplicate discarded", kind, name });
    }
    if ((await drive.fileStatus(winner)) === "live") {
      return winner;
    }
    throw new Error(`drive ${kind} id still missing: ${name}`);
  }

  return claimLocated(bucket, drive, key, name, kind, located);
}

async function claimLocated(
  bucket: R2Bucket,
  drive: { trash(fileId: string): Promise<void> },
  key: string,
  name: string,
  kind: "folder" | "file",
  located: { candidate: string | null; created: string | null },
): Promise<string> {
  if (!located.candidate) {
    throw new Error(`drive ${kind} id missing`);
  }
  const winner = await claimStoredId(bucket, key, located.candidate);
  if (located.created && located.created !== winner) {
    await drive.trash(located.created);
    log({ message: "drive duplicate discarded", kind, name });
  }
  return winner;
}

export async function resolveDriveFolders(
  bucket: R2Bucket,
  drive: DriveFolderClient & { readonly rootFolder: string },
  runId: string,
  objectKey: string,
): Promise<DriveFolders> {
  const generationFolderId = await resolveFolderId(
    bucket,
    drive,
    generationFolderKey(runId),
    runId,
    drive.rootFolder,
  );
  const objectFolderId = await resolveFolderId(
    bucket,
    drive,
    objectFolderKey(runId, objectKey),
    objectKey,
    generationFolderId,
  );
  return { generationFolderId, objectFolderId };
}
