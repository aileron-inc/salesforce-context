import { env } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SyncConfig } from "../src/config";
import { bulkWaitBudgetMs } from "../src/constants";
import {
  fetchWithRetry,
  HttpStatusError,
  isPermanentDrive403,
  isPermanentHttpError,
  shortenDetail,
} from "../src/http";
import { shouldPublishManifest } from "../src/ids";
import { commitObject } from "../src/object-sync";
import { putObjectProgress } from "../src/progress";
import { limitBodyRead } from "../src/salesforce";
import { enqueueSyncSlot } from "../src/slot";
import type { SalesforceSyncEnv } from "../src/env";
import { bulkQueryStillRunningError } from "../src/workflow";
import syncConfig from "./fixtures/sync.config.json";
import {
  longErrorsReasonBody,
  longRpcRateLimitBody,
  longRpcReasonBody,
  longUserRateLimitBody,
  permissionDeniedRateLimitBody,
} from "./google-drive-errors";

const CONFIG = syncConfig as SyncConfig;

describe("review fixes", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete (globalThis as { __SF_RETRY_MS?: number }).__SF_RETRY_MS;
  });

  it("manifest は現在より新しい世代のときだけ進む", () => {
    expect(shouldPublishManifest("2026-10-02-09", "2026-10-02-01")).toBe(true);
    expect(shouldPublishManifest("2026-10-02-01", "2026-10-02-09")).toBe(false);
    expect(shouldPublishManifest("2026-10-02-09", "2026-10-02-09")).toBe(false);
    expect(shouldPublishManifest("2026-10-02-09", null)).toBe(true);
    expect(shouldPublishManifest("2026-10-02-09", "not-a-generation")).toBe(true);
  });

  it("遅れて終わった世代は manifest を戻さない", async () => {
    const older = "2026-01-01-00";
    const newer = "2026-01-02-00";
    const kept = {
      generation: newer,
      objects: {
        accounts: {
          prefix: "kept/",
          parts: ["kept/part-0000.csv"],
          record_count: 9,
          synced_at: "2026-01-02T00:00:00.000Z",
        },
      },
    };
    await env.R2.put("sync.config.json", JSON.stringify(CONFIG));
    await env.R2.put("manifest.json", JSON.stringify(kept));
    for (const key of ["contacts", "opportunities"]) {
      await putObjectProgress(env.R2, older, key, {
        prefix: `generations/${older}/${key}/`,
        parts: [`generations/${older}/${key}/part-0000.csv`],
        record_count: 1,
        synced_at: "2026-01-01T00:00:00.000Z",
      });
    }

    await commitObject(env as SalesforceSyncEnv, {
      runId: older,
      objectKey: "accounts",
      parts: [`generations/${older}/accounts/part-0000.csv`],
      recordCount: 1,
      folders: null,
    });

    const manifest = JSON.parse(await (await env.R2.get("manifest.json"))!.text()) as {
      generation: string;
      objects: { accounts: { record_count: number } };
    };
    expect(manifest.generation).toBe(newer);
    expect(manifest.objects.accounts.record_count).toBe(9);
  });

  it("揃った新しい世代は manifest を進める", async () => {
    const runId = "2026-03-01-00";
    await env.R2.put("sync.config.json", JSON.stringify(CONFIG));
    await env.R2.put(
      "manifest.json",
      JSON.stringify({ generation: "2026-02-01-00", objects: {} }),
    );
    for (const key of ["contacts", "opportunities"]) {
      await putObjectProgress(env.R2, runId, key, {
        prefix: `generations/${runId}/${key}/`,
        parts: [`generations/${runId}/${key}/part-0000.csv`],
        record_count: 1,
        synced_at: "2026-03-01T00:00:00.000Z",
      });
    }

    await commitObject(env as SalesforceSyncEnv, {
      runId,
      objectKey: "accounts",
      parts: [`generations/${runId}/accounts/part-0000.csv`],
      recordCount: 4,
      folders: null,
    });

    const manifest = JSON.parse(await (await env.R2.get("manifest.json"))!.text()) as {
      generation: string;
    };
    expect(manifest.generation).toBe(runId);
  });

  it("Bulk の待ちは約 60 分で、打ち切りはポーリングしない再試行をしない", () => {
    expect(bulkWaitBudgetMs()).toBeGreaterThanOrEqual(60 * 60 * 1000);
    const error = bulkQueryStillRunningError("accounts");
    expect(error).toBeInstanceOf(NonRetryableError);
    expect(isPermanentHttpError(new HttpStatusError("bad request", 400, false))).toBe(true);
    expect(
      isPermanentHttpError(
        new HttpStatusError("rate limit", 403, true),
      ),
    ).toBe(false);
    expect(isPermanentHttpError(new HttpStatusError("missing session", 404, true))).toBe(
      false,
    );
    expect(isPermanentHttpError(new HttpStatusError("missing", 404, false))).toBe(false);
  });

  it("長い Google 403 は理由が 300 バイトより後ろでも判定する", async () => {
    const userRate = longUserRateLimitBody();
    const rpcRate = longRpcRateLimitBody();
    const denied = longErrorsReasonBody("insufficientPermissions");
    const storage = longErrorsReasonBody("storageQuotaExceeded");
    const policy = longErrorsReasonBody("domainPolicy");
    for (const body of [userRate, rpcRate, denied, storage, policy]) {
      expect(body.length).toBeGreaterThan(300);
      expect(body.search(/reason/i)).toBeGreaterThan(300);
    }
    expect(isPermanentDrive403(userRate)).toBe(false);
    expect(isPermanentDrive403(rpcRate)).toBe(false);
    expect(isPermanentDrive403(denied)).toBe(true);
    expect(isPermanentDrive403(storage)).toBe(true);
    expect(isPermanentDrive403(policy)).toBe(true);
    const rpcDenied = longRpcReasonBody("INSUFFICIENT_PERMISSIONS");
    expect(rpcDenied.indexOf("INSUFFICIENT_PERMISSIONS")).toBeGreaterThan(300);
    expect(isPermanentDrive403(rpcDenied)).toBe(true);
    expect(isPermanentDrive403(longRpcReasonBody("notFound"))).toBe(true);
    const rateWithStatus = permissionDeniedRateLimitBody();
    const rateWithDetails = permissionDeniedRateLimitBody({ details: true });
    expect(rateWithStatus).not.toContain('"details"');
    expect(rateWithDetails).toContain("google.rpc.ErrorInfo");
    expect(isPermanentDrive403(rateWithStatus)).toBe(false);
    expect(isPermanentDrive403(rateWithDetails)).toBe(false);
    expect(isPermanentDrive403(longErrorsReasonBody("quotaExceeded"))).toBe(false);
    expect(
      isPermanentDrive403(
        JSON.stringify({
          error: {
            code: 403,
            status: "PERMISSION_DENIED",
            errors: [{ reason: "rate_limit_exceeded" }],
          },
        }),
      ),
    ).toBe(false);
    expect(
      isPermanentDrive403(
        JSON.stringify({
          error: { code: 403, message: "denied", status: "PERMISSION_DENIED" },
        }),
      ),
    ).toBe(true);
    expect(shortenDetail(userRate).length).toBeLessThanOrEqual(300);

    (globalThis as { __SF_RETRY_MS?: number }).__SF_RETRY_MS = 0;
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((message?: unknown) => {
      logs.push(String(message));
    });
    let attempt = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        attempt += 1;
        if (attempt === 1) {
          return new Response(userRate, { status: 403 });
        }
        return new Response("ok");
      }),
    );
    const response = await fetchWithRetry("https://example.test/drive", {}, "Drive list");
    expect(await response.text()).toBe("ok");
    expect(attempt).toBe(2);
    const retry = logs.map((line) => JSON.parse(line) as { detail?: string });
    expect(retry.some((line) => (line.detail?.length ?? 0) <= 300 && (line.detail?.length ?? 0) > 0)).toBe(
      true,
    );
    expect(logs.join("\n")).not.toContain("userRateLimitExceeded");
  });

  it("Salesforce のヘッダタイムアウトは試行ごとに作り直す", async () => {
    (globalThis as { __SF_RETRY_MS?: number }).__SF_RETRY_MS = 0;
    let attempt = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        attempt += 1;
        const signal = init?.signal;
        if (!signal) {
          throw new Error("missing signal");
        }
        if (signal.aborted) {
          throw new Error("signal already aborted");
        }
        if (attempt === 1) {
          await new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => {
              reject(new DOMException("The operation was aborted", "AbortError"));
            });
          });
        }
        return new Response("ok");
      }),
    );

    const response = await fetchWithRetry(
      "https://example.test/query",
      {},
      "Salesforce API",
      30,
    );
    expect(await response.text()).toBe("ok");
    expect(attempt).toBe(2);
  });

  it("結果ボディのタイムアウトは fetch の再試行とは別である", async () => {
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await scheduler.wait(80);
        controller.enqueue(new Uint8Array([1]));
        controller.close();
      },
    });
    const response = limitBodyRead(new Response(stream), 20);
    await expect(response.arrayBuffer()).rejects.toThrow(/Salesforce results body timed out/);
  });

  it("Queue への送信失敗は数回やり直してから大声で失敗する", async () => {
    (globalThis as { __SF_RETRY_MS?: number }).__SF_RETRY_MS = 0;
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((message?: unknown) => {
      errors.push(String(message));
    });
    let sends = 0;
    const queue = {
      async send() {
        sends += 1;
        if (sends < 3) {
          throw new Error("queue unavailable");
        }
      },
    };
    await enqueueSyncSlot(
      { SYNC_QUEUE: queue } as unknown as SalesforceSyncEnv,
      { cron: "3 17,1,9 * * *", scheduledTime: Date.UTC(2026, 6, 30, 17, 0, 0) },
    );
    expect(sends).toBe(3);
    expect(errors).toHaveLength(2);
    expect(errors.join("\n")).toContain("sync enqueue failed");

    sends = 0;
    errors.length = 0;
    const failing = {
      async send() {
        sends += 1;
        throw new Error("queue unavailable");
      },
    };
    await expect(
      enqueueSyncSlot(
        { SYNC_QUEUE: failing } as unknown as SalesforceSyncEnv,
        { cron: "3 17,1,9 * * *", scheduledTime: Date.UTC(2026, 6, 30, 17, 0, 0) },
      ),
    ).rejects.toThrow(/queue unavailable/);
    expect(sends).toBe(4);
    expect(errors).toHaveLength(4);
  });
});
