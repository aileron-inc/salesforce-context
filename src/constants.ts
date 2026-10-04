export const API_VERSION = "v67.0";
export const DEFAULT_LOGIN_URL = "https://login.salesforce.com";
export const POLL_INITIAL_MS = 2_000;
export const POLL_MAX_MS = 30_000;
export const MAX_POLLS = 123;
export const ENQUEUE_ATTEMPTS = 4;
export const SALESFORCE_HEADER_TIMEOUT_MS = 60_000;
export const SALESFORCE_RESULT_BODY_TIMEOUT_MS = 180_000;
export const PAGE_MAX_RECORDS = 10_000;
export const DEFAULT_PART_MAX_BYTES = 8 * 1024 * 1024;
export const UPLOAD_CHUNK_BYTES = 2 * 1024 * 1024;
export const KEEP_GENERATIONS = 6;
export const MAX_RESULT_PAGES = 1_000;

export const SYNC_QUEUE_NAME = "salesforce-context-sync";
export const SYNC_DLQ_NAME = "salesforce-context-sync-dlq";
export const SYNC_WORKFLOW_NAME = "salesforce-context-sync";

export const JSON_MIME = "application/json";
export const CSV_MIME = "text/csv";

export function bulkPollSleepMs(pollIndex: number): number {
  const exponential = POLL_INITIAL_MS * 2 ** Math.max(0, pollIndex);
  return Math.min(exponential, POLL_MAX_MS);
}

export function bulkWaitBudgetMs(maxPolls = MAX_POLLS): number {
  let total = 0;
  for (let poll = 0; poll < maxPolls; poll += 1) {
    total += bulkPollSleepMs(poll);
  }
  return total;
}
