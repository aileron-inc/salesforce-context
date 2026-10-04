import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";

import { loadSyncConfig } from "./config";
import { MAX_POLLS, MAX_RESULT_PAGES, POLL_INITIAL_MS, POLL_MAX_MS } from "./constants";
import type { SalesforceSyncEnv } from "./env";
import { HttpStatusError } from "./http";
import { generationId } from "./ids";
import { log } from "./log";
import { commitObject, stageResultsPage, uploadStagedPart } from "./object-sync";
import { createBulkJob, pollBulkJob, refreshAccessToken } from "./salesforce";

export interface ObjectSyncParams {
  scheduledTime: number;
  objectKey: string;
}

const STEP = {
  retries: {
    limit: 8,
    delay: "30 seconds",
    backoff: "exponential",
  },
  timeout: "15 minutes",
} as const;

export class SyncWorkflow extends WorkflowEntrypoint<
  SalesforceSyncEnv,
  ObjectSyncParams
> {
  async run(
    event: WorkflowEvent<ObjectSyncParams>,
    step: WorkflowStep,
  ): Promise<void> {
    const env = this.env;
    const objectKey = event.payload.objectKey;
    const runId = generationId(event.payload.scheduledTime);

    await step.do(stepLabel("start", objectKey, "0"), STEP, async (ctx) => {
      log({
        message: "object sync started",
        generation: runId,
        object_key: objectKey,
        instance_id: event.instanceId,
        attempt: ctx.attempt,
      });
      return { ok: true };
    });

    const created = await step.do(
      stepLabel("create-job", objectKey, "0"),
      STEP,
      async () => {
        try {
          const syncConfig = await loadSyncConfig(env);
          const objectConfig = syncConfig.objects.find(
            (object) => object.key === objectKey,
          );
          if (!objectConfig) {
            throw new Error(`unknown object key: ${objectKey}`);
          }
          const token = await refreshAccessToken(env);
          const jobId = await createBulkJob(token, objectConfig);
          return { jobId, startedAt: Date.now() };
        } catch (error) {
          rethrowStepError(error);
        }
      },
    );

    let recordCount = 0;
    let polls = 0;
    for (;;) {
      const poll = await step.do(
        stepLabel("poll", objectKey, String(polls)),
        STEP,
        async (ctx) => {
          try {
            const token = await refreshAccessToken(env);
            const job = await pollBulkJob(token, created.jobId);
            if (job.state === "Failed" || job.state === "Aborted") {
              const detail = `Bulk query ${objectKey} ${job.state}: ${job.errorMessage ?? "unknown"}`;
              log({
                message: "bulk query failed",
                generation: runId,
                object_key: objectKey,
                error: detail,
                attempt: ctx.attempt,
              });
              throw new NonRetryableError(detail);
            }
            if (job.state === "JobComplete") {
              const count = job.numberRecordsProcessed ?? 0;
              log({
                message: "bulk query ready",
                generation: runId,
                object_key: objectKey,
                record_count: count,
                bulk_wait_ms: Date.now() - created.startedAt,
                attempt: ctx.attempt,
              });
              return { state: "JobComplete" as const, recordCount: count };
            }
            return {
              state: job.state,
              recordCount: 0,
            };
          } catch (error) {
            rethrowStepError(error);
          }
        },
      );

      if (poll.state === "JobComplete") {
        recordCount = poll.recordCount;
        break;
      }

      if (polls >= MAX_POLLS) {
        await step.do(
          stepLabel("poll-limit", objectKey, String(polls)),
          STEP,
          async () => {
            throw new NonRetryableError(
              `Bulk query ${objectKey} did not complete after ${MAX_POLLS} polls`,
            );
          },
        );
      }

      const waitMs = Math.min(POLL_INITIAL_MS * 2 ** polls, POLL_MAX_MS);
      await step.sleep(stepLabel("wait", objectKey, String(polls)), waitMs);
      polls += 1;
    }

    const parts: string[] = [];
    let locator: string | null = null;
    let page = 0;
    let partIndex = 0;

    for (;;) {
      if (page >= MAX_RESULT_PAGES) {
        await step.do(
          stepLabel("page-limit", objectKey, String(page)),
          STEP,
          async () => {
            throw new NonRetryableError(
              `result pages exceeded ${MAX_RESULT_PAGES} for ${objectKey}`,
            );
          },
        );
      }

      const staged = await step.do(
        stepLabel("page", objectKey, String(page)),
        STEP,
        async (ctx) => {
          try {
            return await stageResultsPage(env, {
              runId,
              objectKey,
              jobId: created.jobId,
              locator,
              partIndex,
              attempt: ctx.attempt,
            });
          } catch (error) {
            rethrowStepError(error);
          }
        },
      );

      for (const part of staged.parts) {
        if (part.path) {
          parts.push(part.path);
          continue;
        }
        const uploaded = await step.do(
          stepLabel("upload", objectKey, part.name),
          STEP,
          async (ctx) => {
            try {
              return await uploadStagedPart(env, {
                runId,
                objectKey,
                part,
                attempt: ctx.attempt,
              });
            } catch (error) {
              rethrowStepError(error);
            }
          },
        );
        parts.push(uploaded.path);
      }

      partIndex += staged.parts.length;
      locator = staged.nextLocator;
      page += 1;
      if (!locator) {
        break;
      }
    }

    await step.do(stepLabel("commit", objectKey, "0"), STEP, async () => {
      try {
        await commitObject(env, {
          runId,
          objectKey,
          parts,
          recordCount,
        });
        return { parts: parts.length, recordCount };
      } catch (error) {
        rethrowStepError(error);
      }
    });
  }
}

function stepLabel(action: string, objectKey: string, suffix: string): string {
  const safeKey = objectKey.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `${action}-${safeKey}-${suffix}`;
}

function rethrowStepError(error: unknown): never {
  if (error instanceof NonRetryableError) {
    throw error;
  }
  if (error instanceof HttpStatusError && !error.retryable) {
    throw new NonRetryableError(error.message);
  }
  if (error instanceof Error && isPermanent(error.message)) {
    throw new NonRetryableError(error.message);
  }
  if (error instanceof Error) {
    throw error;
  }
  throw new Error(String(error));
}

function isPermanent(message: string): boolean {
  return (
    message.startsWith("sync.config.json") ||
    message.startsWith("unknown object key") ||
    message.startsWith("part_max_bytes") ||
    message.includes("drive target requires") ||
    message.startsWith("workflow instance id exceeds")
  );
}
