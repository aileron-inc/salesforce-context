import { loadSyncConfig } from "./config";
import type { SalesforceObjectConfig, SyncConfig } from "./config";
import { DriveClient } from "./drive";
import { R2Target, DriveTarget } from "./target";
import type { SyncTarget } from "./target";

export interface SalesforceSyncEnv {
  R2: R2Bucket;
  SF_CLIENT_ID: string;
  SF_CLIENT_SECRET: string;
  SF_REFRESH_TOKEN: string;
  SF_LOGIN_URL?: string;
  GOOGLE_SERVICE_ACCOUNT_EMAIL?: string;
  GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?: string;
}

interface SalesforceTokenResponse {
  access_token: string;
  instance_url: string;
}

interface BulkJobResponse {
  id: string;
  state: "UploadComplete" | "InProgress" | "JobComplete" | "Failed" | "Aborted";
  errorMessage?: string;
  numberRecordsProcessed?: number;
}

interface ManifestObject {
  prefix: string;
  parts: string[];
  record_count: number;
  synced_at: string;
}

interface Manifest {
  generation: string;
  objects: Record<string, ManifestObject>;
}

const API_VERSION = "v67.0";
const DEFAULT_LOGIN_URL = "https://login.salesforce.com";
const POLL_INITIAL_MS = 2_000;
const POLL_MAX_MS = 30_000;
const PAGE_MAX_RECORDS = 10_000;
const KEEP_GENERATIONS = 6;

interface GenerationState {
  objects: Manifest["objects"];
}

function createTarget(
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
    const client = new DriveClient(
      env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY,
      syncConfig.drive.folder_id,
    );
    return new DriveTarget(client);
  }

  return new R2Target(env.R2);
}

export async function runSync(
  env: SalesforceSyncEnv,
  cron: string,
  scheduledTime: number,
): Promise<void> {
  const syncConfig = await loadSyncConfig(env);
  const objectKeys = syncConfig.cron_groups[cron];
  if (!objectKeys) {
    console.log(
      JSON.stringify({ message: "no objects assigned to cron", cron }),
    );
    return;
  }

  const runId = new Date(scheduledTime)
    .toISOString()
    .slice(0, 13)
    .replace("T", "-");
  const token = await refreshAccessToken(env);
  const target = createTarget(env, syncConfig);

  console.log(
    JSON.stringify({
      message: "sync started",
      generation: runId,
      cron,
      object_keys: objectKeys,
      target: syncConfig.target ?? "r2",
    }),
  );

  const state = (await target.getState<GenerationState>(runId)) ?? {
    objects: {},
  };

  for (const objectKey of objectKeys) {
    const config = syncConfig.objects.find(
      (object) => object.key === objectKey,
    );
    if (!config) {
      throw new Error(`unknown object key: ${objectKey}`);
    }

    const syncedAt = new Date().toISOString();
    const result = await streamBulkQuery(token, config, runId, target);

    const prefix = result.parts.length > 0
      ? result.parts[0].slice(0, result.parts[0].lastIndexOf("/") + 1)
      : `${runId}/${config.key}/`;

    state.objects[config.key] = {
      prefix,
      parts: result.parts,
      record_count: result.recordCount,
      synced_at: syncedAt,
    };

    console.log(
      JSON.stringify({
        message: "object synced",
        generation: runId,
        object_key: config.key,
        record_count: result.recordCount,
        part_count: result.parts.length,
      }),
    );
  }

  await target.putState(runId, state);

  const completedCount = Object.keys(state.objects).length;
  if (completedCount === syncConfig.objects.length) {
    await target.putManifest({ generation: runId, objects: state.objects });

    console.log(
      JSON.stringify({
        message: "sync completed",
        generation: runId,
        object_count: completedCount,
      }),
    );

    await target.cleanupOldGenerations(KEEP_GENERATIONS);
  } else {
    console.log(
      JSON.stringify({
        message: "sync partially completed",
        generation: runId,
        completed_count: completedCount,
        total_count: syncConfig.objects.length,
      }),
    );
  }
}

async function refreshAccessToken(
  env: SalesforceSyncEnv,
): Promise<SalesforceTokenResponse> {
  const loginUrl = env.SF_LOGIN_URL ?? DEFAULT_LOGIN_URL;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: env.SF_CLIENT_ID,
    client_secret: env.SF_CLIENT_SECRET,
    refresh_token: env.SF_REFRESH_TOKEN,
  });
  const response = await fetch(`${loginUrl}/services/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!response.ok) {
    throw new Error(`Salesforce OAuth failed: ${response.status}`);
  }

  return response.json<SalesforceTokenResponse>();
}

async function streamBulkQuery(
  token: SalesforceTokenResponse,
  config: SalesforceObjectConfig,
  runId: string,
  target: SyncTarget,
): Promise<{ parts: string[]; recordCount: number }> {
  const jobsUrl = `${token.instance_url}/services/data/${API_VERSION}/jobs/query`;
  const createResponse = await salesforceFetch(token, jobsUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ operation: "query", query: config.soql }),
  });
  const createdJob = await createResponse.json<BulkJobResponse>();
  const jobUrl = `${jobsUrl}/${createdJob.id}`;

  const recordCount = await waitForJobComplete(token, jobUrl, config.key);

  const parts: string[] = [];
  let locator: string | null = null;
  let partIndex = 0;

  do {
    const url = new URL(`${jobUrl}/results`);
    url.searchParams.set("maxRecords", String(config.max_records ?? PAGE_MAX_RECORDS));
    if (locator) {
      url.searchParams.set("locator", locator);
    }

    const response = await salesforceFetch(token, url.toString());
    const body = await response.arrayBuffer();

    const partName = `part-${String(partIndex).padStart(4, "0")}.csv`;
    const partPath = await target.putPart(
      runId,
      config.key,
      partName,
      body,
    );
    parts.push(partPath);

    partIndex += 1;

    const nextLocator = response.headers.get("Sforce-Locator");
    locator = nextLocator && nextLocator !== "null" ? nextLocator : null;
  } while (locator);

  return { parts, recordCount };
}

async function salesforceFetch(
  token: SalesforceTokenResponse,
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token.access_token}`);
  const response = await fetch(input, { ...init, headers });

  if (!response.ok) {
    throw new Error(`Salesforce API failed: ${response.status}`);
  }

  return response;
}

async function waitForJobComplete(
  token: SalesforceTokenResponse,
  jobUrl: string,
  objectKey: string,
): Promise<number> {
  let interval = POLL_INITIAL_MS;

  for (;;) {
    const response = await salesforceFetch(token, jobUrl);
    const job = await response.json<BulkJobResponse>();

    if (job.state === "JobComplete") {
      return job.numberRecordsProcessed ?? 0;
    }

    if (job.state === "Failed" || job.state === "Aborted") {
      throw new Error(
        `Bulk query ${objectKey} ${job.state}: ${job.errorMessage ?? "unknown"}`,
      );
    }

    await scheduler.wait(interval);
    interval = Math.min(interval * 2, POLL_MAX_MS);
  }
}

export default {
  scheduled(controller, env, ctx) {
    ctx.waitUntil(runSync(env, controller.cron, controller.scheduledTime));
  },
  fetch() {
    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<SalesforceSyncEnv>;
