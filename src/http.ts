import { log } from "./log";

const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504, 524]);
const MAX_ATTEMPTS = 5;
const SNIPPET_BYTES = 300;
const CLASSIFY_BYTES = 8 * 1024;
const PERMANENT_DRIVE_REASONS = new Set([
  "insufficientpermissions",
  "insufficientfilepermissions",
  "insufficientparentpermissions",
  "appnotauthorizedtofile",
  "storagequotaexceeded",
  "forbidden",
  "notfound",
  "domainpolicy",
  "accessnotconfigured",
  "projectnotlinked",
]);

export class HttpStatusError extends Error {
  readonly status: number;
  readonly retryable: boolean;

  constructor(message: string, status: number, retryable: boolean) {
    super(message);
    this.name = "HttpStatusError";
    this.status = status;
    this.retryable = retryable;
  }
}

export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUSES.has(status);
}

export function normalizeDriveReason(value: string): string {
  return value.toLowerCase().replace(/[_\s-]/g, "");
}

export function isPermanentDrive403(body: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return false;
  }

  const reasons = collectDriveReasons(parsed);
  if (reasons.some((reason) => PERMANENT_DRIVE_REASONS.has(normalizeDriveReason(reason)))) {
    return true;
  }
  return driveErrorStatus(parsed) === "permissiondenied";
}

export function isRetryableHttpBody(status: number, body: string): boolean {
  if (isRetryableStatus(status)) {
    return true;
  }
  return status === 403 && !isPermanentDrive403(body);
}

export function isPermanentHttpError(error: HttpStatusError): boolean {
  if (error.retryable) {
    return false;
  }
  return error.status === 400 || error.status === 401 || error.status === 403;
}

export function shortenDetail(detail: string): string {
  return detail.replace(/\s+/g, " ").trim().slice(0, SNIPPET_BYTES);
}

export async function readBodyPrefix(
  response: Response,
  maxBytes: number,
): Promise<string> {
  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done || !value) {
        break;
      }
      const remaining = maxBytes - total;
      chunks.push(value.byteLength > remaining ? value.subarray(0, remaining) : value);
      total += Math.min(value.byteLength, remaining);
    }
  } catch {
    return "";
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The prefix is already captured.
    }
  }

  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export async function errorSnippet(response: Response): Promise<string> {
  return shortenDetail(await readBodyPrefix(response, SNIPPET_BYTES));
}

export async function readErrorBody(response: Response): Promise<string> {
  return readBodyPrefix(response, CLASSIFY_BYTES);
}

export function backoffMs(attempt: number): number {
  // テストだけが 0 を入れる。本番の待機は変えない。
  const override = (globalThis as { __SF_RETRY_MS?: number }).__SF_RETRY_MS;
  if (typeof override === "number") {
    return override;
  }
  return Math.min(1_000 * 2 ** Math.max(0, attempt - 1), 15_000);
}

async function retryWait(attempt: number): Promise<void> {
  await scheduler.wait(backoffMs(attempt));
}

export async function fetchWithRetry(
  input: string,
  init: RequestInit,
  label: string,
  timeoutMs?: number,
): Promise<Response> {
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const controller = timeoutMs === undefined ? null : new AbortController();
    const timer =
      controller === null ? null : setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(input, {
        ...init,
        signal: controller?.signal ?? init.signal,
      });
      if (timer) {
        clearTimeout(timer);
      }
      if (response.ok) {
        return response;
      }

      if (response.status === 403) {
        const body = await readErrorBody(response.clone());
        if (!isPermanentDrive403(body)) {
          const detail = shortenDetail(body);
          lastError = new HttpStatusError(
            formatStatus(label, response.status, detail),
            response.status,
            true,
          );
          log({
            message: "http retry",
            label,
            status: response.status,
            attempt,
            detail,
          });
          if (attempt < MAX_ATTEMPTS) {
            await retryWait(attempt);
          }
          continue;
        }
      }

      if (!isRetryableStatus(response.status)) {
        return response;
      }

      const detail = await errorSnippet(response);
      lastError = new HttpStatusError(
        formatStatus(label, response.status, detail),
        response.status,
        true,
      );
      log({
        message: "http retry",
        label,
        status: response.status,
        attempt,
        detail,
      });
    } catch (error) {
      if (timer) {
        clearTimeout(timer);
      }
      lastError = error instanceof Error ? error : new Error(String(error));
      log({
        message: "http retry",
        label,
        attempt,
        error: lastError.message.slice(0, 300),
      });
    }

    if (attempt < MAX_ATTEMPTS) {
      await retryWait(attempt);
    }
  }

  throw lastError ?? new Error(`${label} failed`);
}

export function formatStatus(label: string, status: number, detail: string): string {
  const suffix = detail ? ` ${detail}` : "";
  return `${label}: ${status}${suffix}`;
}

export async function throwIfNotOk(
  response: Response,
  label: string,
): Promise<void> {
  if (response.ok) {
    return;
  }
  const body =
    response.status === 403
      ? await readErrorBody(response)
      : await readBodyPrefix(response, SNIPPET_BYTES);
  const detail = shortenDetail(body);
  throw new HttpStatusError(
    formatStatus(label, response.status, detail),
    response.status,
    isRetryableHttpBody(response.status, body),
  );
}

function collectDriveReasons(value: unknown): string[] {
  const reasons: string[] = [];
  visitDriveError(value, reasons);
  return reasons;
}

function visitDriveError(value: unknown, reasons: string[]): void {
  if (!value || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      visitDriveError(item, reasons);
    }
    return;
  }

  const record = value as Record<string, unknown>;
  if (typeof record.reason === "string") {
    reasons.push(record.reason);
  }
  if ("error" in record) {
    visitDriveError(record.error, reasons);
  }
  if ("errors" in record) {
    visitDriveError(record.errors, reasons);
  }
  if ("details" in record) {
    visitDriveError(record.details, reasons);
  }
}

function driveErrorStatus(value: unknown): string {
  if (!value || typeof value !== "object") {
    return "";
  }
  const record = value as Record<string, unknown>;
  const error = record.error;
  if (!error || typeof error !== "object" || Array.isArray(error)) {
    return "";
  }
  const status = (error as Record<string, unknown>).status;
  return typeof status === "string" ? normalizeDriveReason(status) : "";
}
