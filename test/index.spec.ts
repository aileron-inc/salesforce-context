import { env } from "cloudflare:workers";
import { introspectWorkflow, type WorkflowIntrospector } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import worker from "../src/index";
import type { SalesforceSyncEnv } from "../src/index";
import type { SyncConfig } from "../src/config";
import { SYNC_DLQ_NAME, SYNC_QUEUE_NAME, SYNC_WORKFLOW_NAME } from "../src/constants";
import type { SyncSlotMessage } from "../src/slot";
import { acceptSyncSlot } from "../src/slot";
import syncConfig from "./fixtures/sync.config.json";
import wranglerConfig from "../wrangler.json";

const SCHEDULED_TIME = Date.UTC(2026, 6, 30, 17, 0, 0);
const RUN_ID = "2026-07-30-17";
const CRONS = Object.keys(syncConfig.cron_groups);
const SALESFORCE_OBJECTS = (syncConfig as SyncConfig).objects;
const FIRST_OBJECT_KEY = (syncConfig as SyncConfig).cron_groups[CRONS[0]][0];

interface Manifest {
  generation: string;
  objects: Record<
    string,
    {
      prefix: string;
      parts: string[];
      record_count: number;
      synced_at: string;
    }
  >;
}

describe("scheduled sync", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete (globalThis as { __SF_RETRY_MS?: number }).__SF_RETRY_MS;
  });

  it("wrangler の Queue / Workflow / cron がコードの契約と一致する", () => {
    expect(wranglerConfig.workflows?.[0]).toMatchObject({
      name: SYNC_WORKFLOW_NAME,
      binding: "SYNC_WORKFLOW",
      class_name: "SyncWorkflow",
    });
    expect(wranglerConfig.queues?.producers?.map((producer) => producer.queue)).toEqual([
      SYNC_QUEUE_NAME,
    ]);
    expect(wranglerConfig.queues?.consumers?.map((consumer) => consumer.queue)).toEqual([
      SYNC_QUEUE_NAME,
      SYNC_DLQ_NAME,
    ]);
    expect(wranglerConfig.triggers?.crons).toEqual([
      "3 17,1,9 * * *",
      "13 17,1,9 * * *",
      "23 17,1,9 * * *",
      "33 17,1,9 * * *",
      "43 17,1,9 * * *",
    ]);
  });

  it("cronごとに担当オブジェクトをCSVのままR2へ保存し、全件完了後にmanifestを更新する", async () => {
    (globalThis as { __SF_RETRY_MS?: number }).__SF_RETRY_MS = 0;
    const jobs = new Map<string, string>();
    const pollCounts = new Map<string, number>();
    stubSalesforce((url, init) => {
      if (
        url === "https://example.my.salesforce.com/services/data/v67.0/jobs/query" &&
        init?.method === "POST"
      ) {
        const body = JSON.parse(init.body?.toString() ?? "{}") as { query?: string };
        const config = SALESFORCE_OBJECTS.find(
          (objectConfig) => objectConfig.soql === body.query,
        );
        if (!config) {
          throw new Error(`unexpected query: ${body.query ?? ""}`);
        }
        const jobId = `job-${config.key}`;
        jobs.set(jobId, config.key);
        return Response.json({ id: jobId, state: "UploadComplete" });
      }

      const jobMatch = url.match(/\/jobs\/query\/(job-[^/?]+)$/);
      if (jobMatch?.[1]) {
        const jobId = jobMatch[1];
        const count = pollCounts.get(jobId) ?? 0;
        pollCounts.set(jobId, count + 1);
        return Response.json({
          id: jobId,
          state: ["UploadComplete", "InProgress", "JobComplete"][count] ?? "JobComplete",
          numberRecordsProcessed: 2,
        });
      }

      const resultMatch = url.match(/\/jobs\/query\/(job-[^/]+)\/results/);
      if (resultMatch?.[1]) {
        const objectKey = jobs.get(resultMatch[1]);
        if (!objectKey) {
          throw new Error(`unknown job: ${resultMatch[1]}`);
        }
        const locator = new URL(url).searchParams.get("locator");
        return new Response(csvFor(objectKey, locator), {
          headers: { "Sforce-Locator": locator === null ? "next-page" : "null" },
        });
      }

      return null;
    });

    await env.R2.put("sync.config.json", JSON.stringify(syncConfig));
    await using introspector = await introspectWorkflow(env.SYNC_WORKFLOW);
    await introspector.modifyAll(async (modifier) => {
      await modifier.disableSleeps();
      await modifier.disableRetryDelays();
    });

    await runCron(CRONS[0], SCHEDULED_TIME);
    await settle(introspector);
    await acceptSyncSlot(env as SalesforceSyncEnv, {
      cron: CRONS[0],
      scheduledTime: SCHEDULED_TIME,
    });

    const partialManifest = await env.R2.get("manifest.json");
    expect(partialManifest).toBeNull();

    const stateAfterFirst = await env.R2.get(`generations/${RUN_ID}/_state.json`);
    expect(stateAfterFirst).not.toBeNull();
    const partialState = JSON.parse(await stateAfterFirst!.text()) as Manifest;
    expect(Object.keys(partialState.objects)).toEqual([FIRST_OBJECT_KEY]);

    for (const cron of CRONS.slice(1)) {
      await runCron(cron, SCHEDULED_TIME);
    }
    await settle(introspector);

    const manifestObject = await env.R2.get("manifest.json");
    expect(manifestObject).not.toBeNull();
    const manifest = JSON.parse(await manifestObject!.text()) as Manifest;
    expect(manifest.generation).toBe(RUN_ID);
    expect(Object.keys(manifest.objects).sort()).toEqual(
      SALESFORCE_OBJECTS.map((config) => config.key).sort(),
    );
    expect(manifest.objects[FIRST_OBJECT_KEY]).toMatchObject({
      prefix: `generations/${RUN_ID}/${FIRST_OBJECT_KEY}/`,
      record_count: 2,
    });
    expect(manifest.objects[FIRST_OBJECT_KEY].parts).toEqual([
      `generations/${RUN_ID}/${FIRST_OBJECT_KEY}/part-0000.csv`,
      `generations/${RUN_ID}/${FIRST_OBJECT_KEY}/part-0001.csv`,
    ]);

    const firstPart = await env.R2.get(manifest.objects[FIRST_OBJECT_KEY].parts[0]);
    expect(await firstPart!.text()).toBe(csvFor(FIRST_OBJECT_KEY, null));
    const secondPart = await env.R2.get(manifest.objects[FIRST_OBJECT_KEY].parts[1]);
    expect(await secondPart!.text()).toBe(csvFor(FIRST_OBJECT_KEY, "next-page"));
  });

  it("フェーズごとの所要時間とパートのバイト数をログする", async () => {
    (globalThis as { __SF_RETRY_MS?: number }).__SF_RETRY_MS = 0;
    const lines: Array<Record<string, unknown>> = [];
    vi.spyOn(console, "log").mockImplementation((message?: unknown) => {
      try {
        lines.push(JSON.parse(String(message)) as Record<string, unknown>);
      } catch {
        // テストランナー自身のログは無視する。
      }
    });
    stubSalesforce((_url, init) => {
      if (init?.method === "POST") {
        return Response.json({ id: "job-1", state: "UploadComplete" });
      }
      if (_url.endsWith("/jobs/query/job-1")) {
        return Response.json({
          id: "job-1",
          state: "JobComplete",
          numberRecordsProcessed: 1,
        });
      }
      if (_url.includes("/results")) {
        return new Response("Id,SystemModstamp\na-1,2026-07-29T00:00:00.000Z", {
          headers: { "Sforce-Locator": "null" },
        });
      }
      return null;
    });

    await env.R2.put("sync.config.json", JSON.stringify(syncConfig));
    await using introspector = await introspectWorkflow(env.SYNC_WORKFLOW);
    await introspector.modifyAll(async (modifier) => {
      await modifier.disableSleeps();
      await modifier.disableRetryDelays();
    });
    await runCron(CRONS[0], SCHEDULED_TIME);
    await settle(introspector);

    expect(lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: "bulk query ready",
          object_key: FIRST_OBJECT_KEY,
          bulk_wait_ms: expect.any(Number),
        }),
        expect.objectContaining({
          message: "page downloaded",
          object_key: FIRST_OBJECT_KEY,
          download_ms: expect.any(Number),
          download_bytes: expect.any(Number),
        }),
        expect.objectContaining({
          message: "part stored",
          object_key: FIRST_OBJECT_KEY,
          bytes: expect.any(Number),
          upload_ms: expect.any(Number),
        }),
      ]),
    );
  });

  it("大きい結果ページはヘッダ付きの複数パートに分けて保存する", async () => {
    (globalThis as { __SF_RETRY_MS?: number }).__SF_RETRY_MS = 0;
    const header = "Id,Name\n";
    const row1 = '"aaa\nbbb",1\n';
    const row2 = "ccc,2";
    const page = `${header}${row1}${row2}`;
    const maxBytes = new TextEncoder().encode(header + row1).byteLength;
    stubSalesforce((_url, init) => {
      if (init?.method === "POST") {
        return Response.json({ id: "job-1", state: "UploadComplete" });
      }
      if (_url.endsWith("/jobs/query/job-1")) {
        return Response.json({
          id: "job-1",
          state: "JobComplete",
          numberRecordsProcessed: 2,
        });
      }
      if (_url.includes("/results")) {
        return new Response(page, { headers: { "Sforce-Locator": "null" } });
      }
      return null;
    });

    const config: SyncConfig = {
      ...(syncConfig as SyncConfig),
      cron_groups: { [CRONS[0]]: [FIRST_OBJECT_KEY] },
      objects: (syncConfig as SyncConfig).objects.filter(
        (object) => object.key === FIRST_OBJECT_KEY,
      ),
      part_max_bytes: maxBytes,
    };
    await env.R2.put("sync.config.json", JSON.stringify(config));
    await using introspector = await introspectWorkflow(env.SYNC_WORKFLOW);
    await introspector.modifyAll(async (modifier) => {
      await modifier.disableSleeps();
      await modifier.disableRetryDelays();
    });
    await runCron(CRONS[0], Date.UTC(2026, 6, 30, 9, 0, 0));
    await settle(introspector);

    const manifest = JSON.parse(
      await (await env.R2.get("manifest.json"))!.text(),
    ) as Manifest;
    const parts = manifest.objects[FIRST_OBJECT_KEY].parts;
    expect(parts.length).toBeGreaterThan(1);
    const bodies = await Promise.all(
      parts.map(async (path) => env.R2.get(path).then((object) => object!.text())),
    );
    expect(bodies.every((body) => body.startsWith(header))).toBe(true);
    expect(bodies.some((body) => body.includes('"aaa\nbbb",1'))).toBe(true);
    expect(manifest.objects[FIRST_OBJECT_KEY].record_count).toBe(2);
  });

  it("結果ダウンロードが 502 でもステップ再試行でパートが保存される", async () => {
    (globalThis as { __SF_RETRY_MS?: number }).__SF_RETRY_MS = 0;
    let resultAttempts = 0;
    stubSalesforce((_url, init) => {
      if (init?.method === "POST") {
        return Response.json({ id: "job-1", state: "UploadComplete" });
      }
      if (_url.endsWith("/jobs/query/job-1")) {
        return Response.json({
          id: "job-1",
          state: "JobComplete",
          numberRecordsProcessed: 1,
        });
      }
      if (_url.includes("/results")) {
        resultAttempts += 1;
        if (resultAttempts === 1) {
          return new Response("upstream timeout", { status: 502 });
        }
        return new Response("Id,SystemModstamp\na-1,2026-07-29T00:00:00.000Z", {
          headers: { "Sforce-Locator": "null" },
        });
      }
      return null;
    });

    const config: SyncConfig = {
      ...(syncConfig as SyncConfig),
      cron_groups: { [CRONS[0]]: [FIRST_OBJECT_KEY] },
      objects: (syncConfig as SyncConfig).objects.filter(
        (object) => object.key === FIRST_OBJECT_KEY,
      ),
    };
    await env.R2.put("sync.config.json", JSON.stringify(config));
    await using introspector = await introspectWorkflow(env.SYNC_WORKFLOW);
    await introspector.modifyAll(async (modifier) => {
      await modifier.disableSleeps();
      await modifier.disableRetryDelays();
    });
    const runId = "2026-07-30-01";
    await runCron(CRONS[0], Date.UTC(2026, 6, 30, 1, 0, 0));
    await settle(introspector);

    expect(resultAttempts).toBeGreaterThan(1);
    const part = await env.R2.get(
      `generations/${runId}/${FIRST_OBJECT_KEY}/part-0000.csv`,
    );
    expect(await part!.text()).toBe("Id,SystemModstamp\na-1,2026-07-29T00:00:00.000Z");
    expect(await env.R2.get("manifest.json")).not.toBeNull();
  });

  it("manifest切替後に直近6世代だけ残して古い世代を削除する", async () => {
    (globalThis as { __SF_RETRY_MS?: number }).__SF_RETRY_MS = 0;
    stubSalesforce((_url, init) => {
      if (init?.method === "POST") {
        return Response.json({ id: "job-1", state: "UploadComplete" });
      }
      if (_url.endsWith("/jobs/query/job-1")) {
        return Response.json({
          id: "job-1",
          state: "JobComplete",
          numberRecordsProcessed: 2,
        });
      }
      if (_url.includes("/results")) {
        return new Response("Id,SystemModstamp\na-1,2026-07-29T00:00:00.000Z", {
          headers: { "Sforce-Locator": "null" },
        });
      }
      return null;
    });

    await env.R2.put("sync.config.json", JSON.stringify(syncConfig));
    for (const generation of [
      "2026-07-29-17",
      "2026-07-30-01",
      "2026-07-30-09",
      "2026-07-30-17",
      "2026-07-31-01",
      "2026-07-31-09",
      "2026-07-31-17",
    ]) {
      await env.R2.put(`generations/${generation}/dummy.csv`, "Id\nold");
    }

    await using introspector = await introspectWorkflow(env.SYNC_WORKFLOW);
    await introspector.modifyAll(async (modifier) => {
      await modifier.disableSleeps();
      await modifier.disableRetryDelays();
    });
    const newerTime = Date.UTC(2026, 7, 1, 1, 0, 0);
    for (const cron of CRONS) {
      await runCron(cron, newerTime);
    }
    await settle(introspector);

    const manifest = JSON.parse(
      await (await env.R2.get("manifest.json"))!.text(),
    ) as Manifest;
    expect(manifest.generation).toBe("2026-08-01-01");

    const generations = new Set<string>();
    let cursor: string | undefined;
    do {
      const listed = await env.R2.list({ prefix: "generations/", cursor });
      for (const object of listed.objects) {
        generations.add(object.key.split("/")[1]);
      }
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);

    expect([...generations].sort()).toEqual([
      "2026-07-30-09",
      "2026-07-30-17",
      "2026-07-31-01",
      "2026-07-31-09",
      "2026-07-31-17",
      "2026-08-01-01",
    ]);
  });

  it("同一cron群の2件目が失敗しても1件目は_state.jsonに残り、manifestは進まない", async () => {
    (globalThis as { __SF_RETRY_MS?: number }).__SF_RETRY_MS = 0;
    const scheduledTime = Date.UTC(2026, 6, 30, 18, 0, 0);
    const runId = "2026-07-30-18";
    const twoObjectCron = CRONS.find(
      (cron) => (syncConfig as SyncConfig).cron_groups[cron].length === 2,
    );
    expect(twoObjectCron).toBeDefined();
    const [firstKey, secondKey] = (syncConfig as SyncConfig).cron_groups[twoObjectCron!];
    const lines: Array<Record<string, unknown>> = [];
    vi.spyOn(console, "log").mockImplementation((message?: unknown) => {
      try {
        lines.push(JSON.parse(String(message)) as Record<string, unknown>);
      } catch {
        // テストランナー自身のログは無視する。
      }
    });

    stubSalesforce((url, init) => {
      if (
        url === "https://example.my.salesforce.com/services/data/v67.0/jobs/query" &&
        init?.method === "POST"
      ) {
        const body = JSON.parse(init.body?.toString() ?? "{}") as { query?: string };
        const config = SALESFORCE_OBJECTS.find(
          (objectConfig) => objectConfig.soql === body.query,
        );
        if (!config) {
          throw new Error(`unexpected query: ${body.query ?? ""}`);
        }
        return Response.json({ id: `job-${config.key}`, state: "UploadComplete" });
      }
      if (url.endsWith(`/jobs/query/job-${firstKey}`)) {
        return Response.json({
          id: `job-${firstKey}`,
          state: "JobComplete",
          numberRecordsProcessed: 2,
        });
      }
      if (url.includes(`/jobs/query/job-${firstKey}/results`)) {
        return new Response(csvFor(firstKey, null), {
          headers: { "Sforce-Locator": "null" },
        });
      }
      if (url.endsWith(`/jobs/query/job-${secondKey}`)) {
        return Response.json({
          id: `job-${secondKey}`,
          state: "Failed",
          errorMessage: "query timed out",
        });
      }
      return null;
    });

    await env.R2.put("sync.config.json", JSON.stringify(syncConfig));
    await env.R2.delete("manifest.json");
    await env.R2.delete(`generations/${runId}/_state.json`);
    await using introspector = await introspectWorkflow(env.SYNC_WORKFLOW);
    await introspector.modifyAll(async (modifier) => {
      await modifier.disableSleeps();
      await modifier.disableRetryDelays();
    });
    await runCron(twoObjectCron!, scheduledTime);
    const instances = await introspector.get();
    expect(instances.length).toBe(2);
    const errors: string[] = [];
    for (const instance of instances) {
      try {
        await instance.waitForStatus("complete");
      } catch {
        await instance.waitForStatus("errored");
        errors.push((await instance.getError()).message);
      }
    }
    expect(errors.length).toBe(1);
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: "bulk query failed",
          object_key: secondKey,
          error: `Bulk query ${secondKey} Failed: query timed out`,
        }),
      ]),
    );

    const stateObject = await env.R2.get(`generations/${runId}/_state.json`);
    expect(stateObject).not.toBeNull();
    const state = JSON.parse(await stateObject!.text()) as Manifest;
    expect(Object.keys(state.objects)).toEqual([firstKey]);
    expect(state.objects[firstKey]).toMatchObject({
      prefix: `generations/${runId}/${firstKey}/`,
      record_count: 2,
    });
    expect(state.objects[firstKey].parts).toEqual([
      `generations/${runId}/${firstKey}/part-0000.csv`,
    ]);
    expect(state.objects[secondKey]).toBeUndefined();
    const firstPart = await env.R2.get(state.objects[firstKey].parts[0]);
    expect(await firstPart!.text()).toBe(csvFor(firstKey, null));
    expect(await env.R2.get("manifest.json")).toBeNull();
  });
});

function stubSalesforce(
  handle: (url: string, init?: RequestInit) => Response | null,
): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url === "https://login.salesforce.com/services/oauth2/token") {
        return Response.json({
          access_token: "test-access-token",
          instance_url: "https://example.my.salesforce.com",
        });
      }
      const response = handle(url, init);
      if (!response) {
        throw new Error(`unexpected fetch: ${url}`);
      }
      return response;
    }),
  );
}

async function runCron(cron: string, scheduledTime: number): Promise<void> {
  const messages: SyncSlotMessage[] = [];
  const send = vi.spyOn(env.SYNC_QUEUE, "send").mockImplementation(async (body) => {
    messages.push(body as SyncSlotMessage);
    return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
  });

  try {
    const waitUntilPromises: Promise<unknown>[] = [];
    worker.scheduled?.(
      { cron, scheduledTime, noRetry() {} },
      env as SalesforceSyncEnv,
      {
        waitUntil(promise) {
          waitUntilPromises.push(promise);
        },
      } as ExecutionContext,
    );
    await Promise.all(waitUntilPromises);
  } finally {
    send.mockRestore();
  }

  expect(messages).toEqual([{ cron, scheduledTime }]);
  const retries: string[] = [];
  await worker.queue?.(
    {
      queue: SYNC_QUEUE_NAME,
      messages: messages.map((body, index) => ({
        id: `${cron}-${index}`,
        timestamp: new Date(scheduledTime),
        body,
        attempts: 1,
        ack() {},
        retry() {
          retries.push(body.cron);
        },
      })),
      ackAll() {},
      retryAll() {
        retries.push(cron);
      },
      metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
    },
    env as SalesforceSyncEnv,
  );
  expect(retries).toEqual([]);
}

async function settle(introspector: WorkflowIntrospector): Promise<void> {
  const instances = await introspector.get();
  for (const instance of instances) {
    try {
      await instance.waitForStatus("complete");
    } catch (error) {
      await instance.waitForStatus("errored");
      const detail = await instance.getError();
      throw new Error(detail.message || String(error));
    }
  }
}

function csvFor(objectKey: string, locator: string | null): string {
  if (objectKey === FIRST_OBJECT_KEY && locator === null) {
    return [
      "Id,SystemModstamp,Name",
      'record-1,2026-07-29T00:00:00.000Z,"1行目\n2行目"',
    ].join("\n");
  }

  if (objectKey === FIRST_OBJECT_KEY) {
    return [
      "Id,SystemModstamp,Name",
      'record-2,2026-07-29T00:01:00.000Z,"カンマ, と引用符""あり"',
    ].join("\n");
  }

  return [
    "Id,SystemModstamp",
    `a-${objectKey}-1,2026-07-29T00:00:00.000Z`,
    `a-${objectKey}-2,2026-07-29T00:01:00.000Z`,
  ].join("\n");
}
