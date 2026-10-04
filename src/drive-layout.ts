import { JSON_MIME } from "./constants";
import { log } from "./log";

interface DriveFolderClient {
  findFolder(name: string, parentId: string): Promise<string | null>;
  createFolder(name: string, parentId: string): Promise<string>;
  trash(fileId: string): Promise<void>;
}

interface DriveFileClient {
  findFileId(name: string, parentId: string): Promise<string | null>;
  createEmptyFile(name: string, parentId: string, mimeType: string): Promise<string>;
  trash(fileId: string): Promise<void>;
}

export interface DriveFolders {
  generationFolderId: string;
  objectFolderId: string;
}

interface StoredDriveId {
  id: string;
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
  const object = await bucket.get(key);
  if (!object) {
    return null;
  }
  const parsed = await object.json<StoredDriveId>();
  return parsed.id || null;
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
  const stored = await readStoredId(bucket, key);
  if (stored) {
    return stored;
  }

  const listed = await drive.findFolder(name, parentId);
  const created = listed ? null : await drive.createFolder(name, parentId);
  const candidate = listed ?? created;
  if (!candidate) {
    throw new Error("drive folder id missing");
  }

  const winner = await claimStoredId(bucket, key, candidate);
  if (created && created !== winner) {
    await drive.trash(created);
    log({ message: "drive duplicate discarded", kind: "folder", name });
  }
  return winner;
}

export async function resolveFileId(
  bucket: R2Bucket,
  drive: DriveFileClient,
  key: string,
  name: string,
  parentId: string,
  mimeType: string,
): Promise<string> {
  const stored = await readStoredId(bucket, key);
  if (stored) {
    return stored;
  }

  const listed = await drive.findFileId(name, parentId);
  const created = listed ? null : await drive.createEmptyFile(name, parentId, mimeType);
  const candidate = listed ?? created;
  if (!candidate) {
    throw new Error("drive file id missing");
  }

  const winner = await claimStoredId(bucket, key, candidate);
  if (created && created !== winner) {
    await drive.trash(created);
    log({ message: "drive duplicate discarded", kind: "file", name });
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
