import type { SalesforceObjectConfig } from "./config";
import {
  API_VERSION,
  DEFAULT_LOGIN_URL,
  PAGE_MAX_RECORDS,
  SALESFORCE_HEADER_TIMEOUT_MS,
  SALESFORCE_RESULT_BODY_TIMEOUT_MS,
} from "./constants";
import type { SalesforceSyncEnv } from "./env";
import { fetchWithRetry, throwIfNotOk } from "./http";

export interface SalesforceToken {
  access_token: string;
  instance_url: string;
}

export interface BulkJob {
  id: string;
  state: "UploadComplete" | "InProgress" | "JobComplete" | "Failed" | "Aborted";
  errorMessage?: string;
  numberRecordsProcessed?: number;
}

export async function refreshAccessToken(
  env: SalesforceSyncEnv,
): Promise<SalesforceToken> {
  const loginUrl = env.SF_LOGIN_URL ?? DEFAULT_LOGIN_URL;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: env.SF_CLIENT_ID,
    refresh_token: env.SF_REFRESH_TOKEN,
  });
  if (env.SF_CLIENT_SECRET) {
    body.set("client_secret", env.SF_CLIENT_SECRET);
  }

  const response = await fetchWithRetry(
    `${loginUrl}/services/oauth2/token`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    },
    "Salesforce OAuth",
  );
  await throwIfNotOk(response, "Salesforce OAuth failed");
  return response.json<SalesforceToken>();
}

export async function createBulkJob(
  token: SalesforceToken,
  config: SalesforceObjectConfig,
): Promise<string> {
  const response = await salesforceFetch(
    token,
    `${token.instance_url}/services/data/${API_VERSION}/jobs/query`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ operation: "query", query: config.soql }),
    },
  );
  const created = await response.json<BulkJob>();
  return created.id;
}

export async function pollBulkJob(
  token: SalesforceToken,
  jobId: string,
): Promise<BulkJob> {
  const response = await salesforceFetch(
    token,
    `${token.instance_url}/services/data/${API_VERSION}/jobs/query/${jobId}`,
  );
  return response.json<BulkJob>();
}

export async function openResultsPage(
  token: SalesforceToken,
  jobId: string,
  locator: string | null,
  maxRecords: number,
): Promise<{ response: Response; nextLocator: string | null }> {
  const url = new URL(
    `${token.instance_url}/services/data/${API_VERSION}/jobs/query/${jobId}/results`,
  );
  url.searchParams.set("maxRecords", String(maxRecords));
  if (locator) {
    url.searchParams.set("locator", locator);
  }

  const response = await salesforceFetch(token, url.toString());
  const next = response.headers.get("Sforce-Locator");
  return {
    response: limitBodyRead(response, SALESFORCE_RESULT_BODY_TIMEOUT_MS),
    nextLocator: next && next !== "null" ? next : null,
  };
}

export function limitBodyRead(response: Response, timeoutMs: number): Response {
  if (!response.body) {
    return response;
  }

  const reader = response.body.getReader();
  const started = Date.now();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const remaining = timeoutMs - (Date.now() - started);
      if (remaining <= 0) {
        await reader.cancel();
        controller.error(new Error("Salesforce results body timed out"));
        return;
      }

      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("Salesforce results body timed out")),
              remaining,
            );
          }),
        ]);
        if (result.done) {
          controller.close();
          return;
        }
        controller.enqueue(result.value);
      } catch (error) {
        await reader.cancel().catch(() => undefined);
        controller.error(error instanceof Error ? error : new Error(String(error)));
      } finally {
        if (timer) {
          clearTimeout(timer);
        }
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });

  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export function pageMaxRecords(config: SalesforceObjectConfig): number {
  return config.max_records ?? PAGE_MAX_RECORDS;
}

async function salesforceFetch(
  token: SalesforceToken,
  input: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token.access_token}`);
  const response = await fetchWithRetry(
    input,
    {
      ...init,
      headers,
    },
    "Salesforce API",
    SALESFORCE_HEADER_TIMEOUT_MS,
  );
  await throwIfNotOk(response, "Salesforce API failed");
  return response;
}
