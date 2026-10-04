import { loadSyncConfig } from "./config";
import { consumeCsvParts } from "./csv-parts";
import {
  CSV_MIME,
  DEFAULT_PART_MAX_BYTES,
  KEEP_GENERATIONS,
} from "./constants";
import type { SalesforceSyncEnv } from "./env";
import { log } from "./log";
import {
  cleanupRuntimeArtifacts,
  listObjectProgress,
  orderObjects,
  putObjectProgress,
  stagingKey,
  type ObjectSyncResult,
} from "./progress";
import {
  openResultsPage,
  pageMaxRecords,
  refreshAccessToken,
} from "./salesforce";
import { createTarget, deleteR2Prefix } from "./target";

export interface StagedPart {
  name: string;
  bytes: number;
  path?: string;
  stagingKey?: string;
}

export interface StagePageResult {
  nextLocator: string | null;
  downloadMs: number;
  downloadBytes: number;
  parts: StagedPart[];
}

export function partName(index: number): string {
  return `part-${String(index).padStart(4, "0")}.csv`;
}

export async function stageResultsPage(
  env: SalesforceSyncEnv,
  args: {
    runId: string;
    objectKey: string;
    jobId: string;
    locator: string | null;
    partIndex: number;
    attempt: number;
  },
): Promise<StagePageResult> {
  const syncConfig = await loadSyncConfig(env);
  const objectConfig = syncConfig.objects.find(
    (object) => object.key === args.objectKey,
  );
  if (!objectConfig) {
    throw new Error(`unknown object key: ${args.objectKey}`);
  }

  const target = createTarget(env, syncConfig);
  const token = await refreshAccessToken(env);
  const maxBytes = syncConfig.part_max_bytes ?? DEFAULT_PART_MAX_BYTES;
  const drive = syncConfig.target === "drive";

  const started = Date.now();
  const opened = await openResultsPage(
    token,
    args.jobId,
    args.locator,
    pageMaxRecords(objectConfig),
  );
  const headerMs = Date.now() - started;
  if (!opened.response.body) {
    throw new Error("Salesforce results body missing");
  }

  const parts: StagedPart[] = [];
  let nextIndex = args.partIndex;
  const consumed = await consumeCsvParts(
    opened.response.body,
    maxBytes,
    async (part) => {
      const name = partName(nextIndex);
      nextIndex += 1;
      if (drive) {
        const key = stagingKey(args.runId, args.objectKey, name);
        await env.R2.put(key, part, {
          httpMetadata: { contentType: CSV_MIME },
        });
        parts.push({ name, bytes: part.byteLength, stagingKey: key });
        log({
          message: "part staged",
          generation: args.runId,
          object_key: args.objectKey,
          part: name,
          bytes: part.byteLength,
          attempt: args.attempt,
        });
        return;
      }

      const uploadStarted = Date.now();
      const path = await target.putPart(
        args.runId,
        args.objectKey,
        name,
        part,
      );
      parts.push({ name, bytes: part.byteLength, path });
      log({
        message: "part stored",
        generation: args.runId,
        object_key: args.objectKey,
        part: name,
        bytes: part.byteLength,
        upload_ms: Date.now() - uploadStarted,
        target: "r2",
        attempt: args.attempt,
      });
    },
  );

  log({
    message: "page downloaded",
    generation: args.runId,
    object_key: args.objectKey,
    download_ms: headerMs + consumed.readMs,
    download_bytes: consumed.totalBytes,
    part_count: parts.length,
    attempt: args.attempt,
  });

  return {
    nextLocator: opened.nextLocator,
    downloadMs: headerMs + consumed.readMs,
    downloadBytes: consumed.totalBytes,
    parts,
  };
}

export async function uploadStagedPart(
  env: SalesforceSyncEnv,
  args: {
    runId: string;
    objectKey: string;
    part: StagedPart;
    attempt: number;
  },
): Promise<{ path: string; bytes: number; uploadMs: number }> {
  if (!args.part.stagingKey) {
    throw new Error(`staged part missing key: ${args.part.name}`);
  }

  const syncConfig = await loadSyncConfig(env);
  const target = createTarget(env, syncConfig);
  const object = await env.R2.get(args.part.stagingKey);
  if (!object) {
    throw new Error(`staged part missing: ${args.part.stagingKey}`);
  }

  const bytes = new Uint8Array(await object.arrayBuffer());
  const uploadStarted = Date.now();
  const path = await target.putPart(
    args.runId,
    args.objectKey,
    args.part.name,
    bytes,
  );
  const uploadMs = Date.now() - uploadStarted;
  log({
    message: "part stored",
    generation: args.runId,
    object_key: args.objectKey,
    part: args.part.name,
    bytes: bytes.byteLength,
    upload_ms: uploadMs,
    target: syncConfig.target ?? "r2",
    attempt: args.attempt,
  });
  return { path, bytes: bytes.byteLength, uploadMs };
}

export async function commitObject(
  env: SalesforceSyncEnv,
  args: {
    runId: string;
    objectKey: string;
    parts: string[];
    recordCount: number;
  },
): Promise<void> {
  const syncConfig = await loadSyncConfig(env);
  const target = createTarget(env, syncConfig);
  const keyOrder = syncConfig.objects.map((object) => object.key);
  const prefix = args.parts.length > 0
    ? args.parts[0].slice(0, args.parts[0].lastIndexOf("/") + 1)
    : `${args.runId}/${args.objectKey}/`;
  const result: ObjectSyncResult = {
    prefix,
    parts: args.parts,
    record_count: args.recordCount,
    synced_at: new Date().toISOString(),
  };

  await putObjectProgress(env.R2, args.runId, args.objectKey, result);
  const objects = orderObjects(
    await listObjectProgress(env.R2, args.runId),
    keyOrder,
  );
  await target.putState(args.runId, { objects });

  const completed = keyOrder.every((key) => objects[key]);
  if (completed) {
    await target.putManifest({ generation: args.runId, objects });
    log({
      message: "sync completed",
      generation: args.runId,
      object_count: keyOrder.length,
    });
    await target.cleanupOldGenerations(KEEP_GENERATIONS);
    await cleanupRuntimeArtifacts(env.R2, KEEP_GENERATIONS);
  } else {
    log({
      message: "sync partially completed",
      generation: args.runId,
      object_key: args.objectKey,
      completed_count: Object.keys(objects).length,
      total_count: keyOrder.length,
    });
  }

  await deleteR2Prefix(env.R2, `staging/${args.runId}/${args.objectKey}/`);
  log({
    message: "object synced",
    generation: args.runId,
    object_key: args.objectKey,
    record_count: args.recordCount,
    part_count: args.parts.length,
  });
}
