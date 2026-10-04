import { JSON_MIME } from "./constants";
import { log } from "./log";
import { deleteR2Prefix } from "./target";

export interface ObjectSyncResult {
  prefix: string;
  parts: string[];
  record_count: number;
  synced_at: string;
}

export interface GenerationState {
  objects: Record<string, ObjectSyncResult>;
}

export function progressKey(runId: string, objectKey: string): string {
  return `generations/${runId}/_objects/${objectKey}.json`;
}

export function stagingKey(
  runId: string,
  objectKey: string,
  partName: string,
): string {
  return `staging/${runId}/${objectKey}/${partName}`;
}

export async function putObjectProgress(
  bucket: R2Bucket,
  runId: string,
  objectKey: string,
  result: ObjectSyncResult,
): Promise<void> {
  await bucket.put(progressKey(runId, objectKey), JSON.stringify(result), {
    httpMetadata: { contentType: JSON_MIME },
  });
}

export async function listObjectProgress(
  bucket: R2Bucket,
  runId: string,
): Promise<Record<string, ObjectSyncResult>> {
  const objects: Record<string, ObjectSyncResult> = {};
  let cursor: string | undefined;

  do {
    const listed = await bucket.list({
      prefix: `generations/${runId}/_objects/`,
      cursor,
    });
    for (const object of listed.objects) {
      const name = object.key.split("/").pop();
      if (!name?.endsWith(".json")) {
        continue;
      }
      const body = await bucket.get(object.key);
      if (!body) {
        continue;
      }
      objects[name.slice(0, -".json".length)] = await body.json<ObjectSyncResult>();
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  return objects;
}

export function orderObjects(
  objects: Record<string, ObjectSyncResult>,
  keyOrder: readonly string[],
): Record<string, ObjectSyncResult> {
  const ordered: Record<string, ObjectSyncResult> = {};
  for (const key of keyOrder) {
    const value = objects[key];
    if (value) {
      ordered[key] = value;
    }
  }
  return ordered;
}

export async function cleanupRuntimeArtifacts(
  bucket: R2Bucket,
  keepCount: number,
): Promise<void> {
  const ids = new Set<string>();
  await collectChildIds(bucket, "staging/", ids);
  await collectChildIds(bucket, "generations/", ids);

  const stale = [...ids]
    .sort()
    .slice(0, Math.max(0, ids.size - keepCount));

  for (const id of stale) {
    await deleteR2Prefix(bucket, `staging/${id}/`);
    await deleteR2Prefix(bucket, `generations/${id}/_objects/`);
    log({ message: "runtime artifacts deleted", generation: id });
  }
}

async function collectChildIds(
  bucket: R2Bucket,
  prefix: string,
  ids: Set<string>,
): Promise<void> {
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ prefix, delimiter: "/", cursor });
    for (const child of listed.delimitedPrefixes) {
      const id = child.slice(prefix.length).replace(/\/$/, "");
      if (id) {
        ids.add(id);
      }
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}
