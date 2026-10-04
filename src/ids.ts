const GENERATION_ID = /^\d{4}-\d{2}-\d{2}-\d{2}$/;

export function shouldPublishManifest(
  candidate: string,
  current: string | null | undefined,
): boolean {
  if (!current || !GENERATION_ID.test(current)) {
    return true;
  }
  if (!GENERATION_ID.test(candidate)) {
    return false;
  }
  return candidate > current;
}

export function generationId(scheduledTime: number): string {
  return new Date(scheduledTime)
    .toISOString()
    .slice(0, 13)
    .replace("T", "-");
}

export function workflowInstanceId(runId: string, objectKey: string): string {
  const raw = `sync_${runId}_${objectKey}`.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (raw.length > 100) {
    throw new Error(
      `workflow instance id exceeds 100 characters for object ${objectKey}`,
    );
  }
  return raw;
}
