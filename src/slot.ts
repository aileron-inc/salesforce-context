import { NonRetryableError } from "cloudflare:workflows";

import { loadSyncConfig } from "./config";
import { SYNC_DLQ_NAME } from "./constants";
import type { SalesforceSyncEnv } from "./env";
import { generationId, workflowInstanceId } from "./ids";
import { log, safeError } from "./log";
import type { ObjectSyncParams } from "./workflow";

export interface SyncSlotMessage {
  cron: string;
  scheduledTime: number;
}

export async function enqueueSyncSlot(
  env: SalesforceSyncEnv,
  message: SyncSlotMessage,
): Promise<void> {
  try {
    await env.SYNC_QUEUE.send(message);
    log({
      message: "sync queued",
      cron: message.cron,
      scheduled_time: message.scheduledTime,
      generation: generationId(message.scheduledTime),
    });
  } catch (error) {
    log({
      message: "sync enqueue failed",
      cron: message.cron,
      error: safeError(error),
    });
    throw error;
  }
}

export async function handleSyncBatch(
  batch: MessageBatch<SyncSlotMessage>,
  env: SalesforceSyncEnv,
): Promise<void> {
  if (batch.queue === SYNC_DLQ_NAME) {
    for (const message of batch.messages) {
      const body = message.body;
      log({
        message: "sync slot dead letter",
        cron: typeof body?.cron === "string" ? body.cron : "",
        scheduled_time:
          typeof body?.scheduledTime === "number" ? body.scheduledTime : 0,
        attempts: message.attempts,
      });
      message.ack();
    }
    return;
  }

  for (const message of batch.messages) {
    const parsed = parseSlot(message.body);
    if (!parsed) {
      log({ message: "sync slot rejected", attempts: message.attempts });
      message.ack();
      continue;
    }

    try {
      await acceptSyncSlot(env, parsed);
      message.ack();
    } catch (error) {
      if (error instanceof NonRetryableError) {
        log({
          message: "sync slot rejected",
          cron: parsed.cron,
          error: error.message,
        });
        message.ack();
        continue;
      }
      log({
        message: "sync slot failed",
        cron: parsed.cron,
        error: safeError(error),
      });
      message.retry();
    }
  }
}

export async function acceptSyncSlot(
  env: SalesforceSyncEnv,
  message: SyncSlotMessage,
): Promise<string[]> {
  const syncConfig = await loadSyncConfig(env);
  const objectKeys = syncConfig.cron_groups[message.cron];
  const runId = generationId(message.scheduledTime);
  if (!objectKeys || objectKeys.length === 0) {
    log({
      message: "no objects assigned to cron",
      cron: message.cron,
      generation: runId,
    });
    return [];
  }

  log({
    message: "sync slot accepted",
    cron: message.cron,
    generation: runId,
    object_keys: objectKeys,
  });

  const instanceIds: string[] = [];
  for (const objectKey of objectKeys) {
    if (!syncConfig.objects.some((object) => object.key === objectKey)) {
      throw new NonRetryableError(`unknown object key: ${objectKey}`);
    }
    const params: ObjectSyncParams = {
      scheduledTime: message.scheduledTime,
      objectKey,
    };
    const action = await ensureObjectWorkflow(env.SYNC_WORKFLOW, params);
    const instanceId = workflowInstanceId(runId, objectKey);
    instanceIds.push(instanceId);
    log({
      message: "object workflow ready",
      generation: runId,
      object_key: objectKey,
      instance_id: instanceId,
      action,
    });
  }
  return instanceIds;
}

export async function ensureObjectWorkflow(
  workflow: Workflow<ObjectSyncParams>,
  params: ObjectSyncParams,
): Promise<"created" | "restarted" | "running" | "complete"> {
  const id = workflowInstanceId(
    generationId(params.scheduledTime),
    params.objectKey,
  );
  try {
    await workflow.create({ id, params });
    return "created";
  } catch (error) {
    const message = safeError(error);
    if (!/already exists/i.test(message)) {
      throw error;
    }
  }

  const instance = await workflow.get(id);
  const current = await instance.status();
  if (current.status === "complete") {
    return "complete";
  }
  if (current.status === "errored" || current.status === "terminated") {
    await instance.restart();
    return "restarted";
  }
  return "running";
}

function parseSlot(body: unknown): SyncSlotMessage | null {
  if (!body || typeof body !== "object") {
    return null;
  }
  const record = body as { cron?: unknown; scheduledTime?: unknown };
  if (typeof record.cron !== "string" || typeof record.scheduledTime !== "number") {
    return null;
  }
  if (!Number.isFinite(record.scheduledTime)) {
    return null;
  }
  return { cron: record.cron, scheduledTime: record.scheduledTime };
}
