export interface SalesforceObjectConfig {
  key: string;
  label: string;
  soql: string;
}

export interface SyncConfig {
  cron_groups: Record<string, string[]>;
  objects: SalesforceObjectConfig[];
  target?: "r2" | "drive";
  drive?: {
    folder_id: string;
  };
}

export const SYNC_CONFIG_KEY = "sync.config.json";

export async function loadSyncConfig(env: {
  R2: R2Bucket;
}): Promise<SyncConfig> {
  const configObject = await env.R2.get(SYNC_CONFIG_KEY);
  if (!configObject) {
    throw new Error(`${SYNC_CONFIG_KEY} not found in R2 bucket`);
  }

  const config = await configObject.json<SyncConfig>();
  validateSyncConfig(config);

  return config;
}

function validateSyncConfig(config: SyncConfig): void {
  if (!Array.isArray(config.objects) || config.objects.length === 0) {
    throw new Error(`${SYNC_CONFIG_KEY}: objects must be a non-empty array`);
  }

  for (const object of config.objects) {
    if (!object.key || !object.label || !object.soql) {
      throw new Error(
        `${SYNC_CONFIG_KEY}: each object requires key, label and soql`,
      );
    }
  }

  const objectKeys = new Set(config.objects.map((object) => object.key));

  for (const [cron, keys] of Object.entries(config.cron_groups ?? {})) {
    for (const key of keys) {
      if (!objectKeys.has(key)) {
        throw new Error(
          `${SYNC_CONFIG_KEY}: cron "${cron}" references unknown object "${key}"`,
        );
      }
    }
  }
}
