import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(() => ({
      wrangler: {
        configPath: "./wrangler.json",
      },
      miniflare: {
        bindings: {
          SF_CLIENT_ID: "test-client-id",
          SF_CLIENT_SECRET: "test-client-secret",
          SF_REFRESH_TOKEN: "test-refresh-token",
        },
      },
    })),
  ],
});
