import { log } from "./log";

const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504, 524]);
const MAX_ATTEMPTS = 5;
const SNIPPET_BYTES = 300;

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

export async function errorSnippet(response: Response): Promise<string> {
  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (total < SNIPPET_BYTES) {
      const { done, value } = await reader.read();
      if (done || !value) {
        break;
      }
      const remaining = SNIPPET_BYTES - total;
      chunks.push(value.byteLength > remaining ? value.subarray(0, remaining) : value);
      total += Math.min(value.byteLength, remaining);
    }
  } catch {
    return "";
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The snippet is already captured.
    }
  }

  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder()
    .decode(bytes)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, SNIPPET_BYTES);
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
): Promise<Response> {
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(input, init);
      if (response.ok || !isRetryableStatus(response.status)) {
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
  const detail = await errorSnippet(response);
  throw new HttpStatusError(
    formatStatus(label, response.status, detail),
    response.status,
    isRetryableStatus(response.status),
  );
}
