import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import worker from "../src/index";
import type { SalesforceSyncEnv } from "../src/index";
import type { SyncConfig } from "../src/config";
import syncConfig from "./fixtures/sync.config.json";

const SCHEDULED_TIME = Date.UTC(2026, 6, 30, 17, 0, 0);
const RUN_ID = "2026-07-30-17";
const CRONS = Object.keys(syncConfig.cron_groups);
const SALESFORCE_OBJECTS = (syncConfig as SyncConfig).objects;

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
  });

  it("cronごとに担当オブジェクトをCSVのままR2へ保存し、全件完了後にmanifestを更新する", async () => {
    const jobs = new Map<string, string>();
    const pollCounts = new Map<string, number>();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();

      if (url === "https://login.salesforce.com/services/oauth2/token") {
        return Response.json({
          access_token: "test-access-token",
          instance_url: "https://example.my.salesforce.com",
        });
      }

      if (
        url ===
          "https://example.my.salesforce.com/services/data/v67.0/jobs/query" &&
        init?.method === "POST"
      ) {
        const body = JSON.parse(init.body?.toString() ?? "{}") as {
          query?: string;
        };
        const config = SALESFORCE_OBJECTS.find((objectConfig) =>
          body.query?.includes(` FROM ${fromObject(objectConfig.key)}`),
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
          state: ["UploadComplete", "InProgress", "JobComplete"][count] ??
            "JobComplete",
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
          headers: {
            "Sforce-Locator": locator === null ? "next-page" : "null",
          },
        });
      }

      throw new Error(`unexpected fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("scheduler", { wait: async () => {} });

    await env.R2.put("sync.config.json", JSON.stringify(syncConfig));

    const runCron = async (cron: string) => {
      const waitUntilPromises: Promise<unknown>[] = [];
      worker.scheduled?.(
        { cron, scheduledTime: SCHEDULED_TIME, noRetry() {} },
        env as SalesforceSyncEnv,
        {
          waitUntil(promise) {
            waitUntilPromises.push(promise);
          },
        } as ExecutionContext,
      );
      await Promise.all(waitUntilPromises);
    };

    await runCron(CRONS[0]);

    const partialManifest = await env.R2.get("manifest.json");
    expect(partialManifest).toBeNull();

    const stateAfterFirst = await env.R2.get(
      `generations/${RUN_ID}/_state.json`,
    );
    expect(stateAfterFirst).not.toBeNull();
    const partialState = JSON.parse(await stateAfterFirst!.text()) as Manifest;
    expect(Object.keys(partialState.objects)).toEqual(["candidates"]);

    for (const cron of CRONS.slice(1)) {
      await runCron(cron);
    }

    const manifestObject = await env.R2.get("manifest.json");
    expect(manifestObject).not.toBeNull();

    const manifest = JSON.parse(await manifestObject!.text()) as Manifest;
    expect(manifest.generation).toBe(RUN_ID);
    expect(Object.keys(manifest.objects).sort()).toEqual(
      SALESFORCE_OBJECTS.map((config) => config.key).sort(),
    );
    expect(manifest.objects.candidates).toMatchObject({
      prefix: `generations/${RUN_ID}/candidates/`,
      record_count: 2,
    });
    expect(manifest.objects.candidates.parts).toEqual([
      `generations/${RUN_ID}/candidates/part-0000.csv`,
      `generations/${RUN_ID}/candidates/part-0001.csv`,
    ]);

    const firstPart = await env.R2.get(
      manifest.objects.candidates.parts[0],
    );
    expect(await firstPart!.text()).toBe(csvFor("candidates", null));

    const secondPart = await env.R2.get(
      manifest.objects.candidates.parts[1],
    );
    expect(await secondPart!.text()).toBe(csvFor("candidates", "next-page"));
  });

  it("manifest切替後に直近6世代だけ残して古い世代を削除する", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();

      if (url === "https://login.salesforce.com/services/oauth2/token") {
        return Response.json({
          access_token: "test-access-token",
          instance_url: "https://example.my.salesforce.com",
        });
      }

      if (
        url ===
          "https://example.my.salesforce.com/services/data/v67.0/jobs/query" &&
        init?.method === "POST"
      ) {
        return Response.json({ id: "job-1", state: "UploadComplete" });
      }

      if (url.endsWith("/jobs/query/job-1")) {
        return Response.json({
          id: "job-1",
          state: "JobComplete",
          numberRecordsProcessed: 2,
        });
      }

      if (url.includes("/jobs/query/job-1/results")) {
        return new Response("Id,SystemModstamp\na-1,2026-07-29T00:00:00.000Z", {
          headers: { "Sforce-Locator": "null" },
        });
      }

      throw new Error(`unexpected fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("scheduler", { wait: async () => {} });

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

    const newerTime = Date.UTC(2026, 7, 1, 1, 0, 0);
    for (const cron of CRONS) {
      const waitUntilPromises: Promise<unknown>[] = [];
      worker.scheduled?.(
        { cron, scheduledTime: newerTime, noRetry() {} },
        env as SalesforceSyncEnv,
        {
          waitUntil(promise) {
            waitUntilPromises.push(promise);
          },
        } as ExecutionContext,
      );
      await Promise.all(waitUntilPromises);
    }

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
});

function csvFor(objectKey: string, locator: string | null): string {
  if (objectKey === "candidates" && locator === null) {
    return [
      "Id,SystemModstamp,Account.ID_18__c,TalentAge__c,Account.BriefSummary__c",
      '003000000000001AAA,2026-07-29T00:00:00.000Z,001000000000001AAA,31,"1行目\n2行目"',
    ].join("\n");
  }

  if (objectKey === "candidates") {
    return [
      "Id,SystemModstamp,Account.ID_18__c,TalentAge__c,Account.BriefSummary__c",
      '003000000000002AAA,2026-07-29T00:01:00.000Z,001000000000002AAA,42,"カンマ, と引用符""あり"',
    ].join("\n");
  }

  return [
    "Id,SystemModstamp",
    `a-${objectKey}-1,2026-07-29T00:00:00.000Z`,
    `a-${objectKey}-2,2026-07-29T00:01:00.000Z`,
  ].join("\n");
}

function fromObject(objectKey: string): string {
  const fromObjects: Record<string, string> = {
    candidates: "Contact",
    jobs: "Opportunity",
    companies: "Account",
    matchings: "Matching__c",
    contracts: "Contract__c",
    interviews: "Interview__c",
    interviewers: "InterviewParticipant__c",
  };

  return fromObjects[objectKey];
}
