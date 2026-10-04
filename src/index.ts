import type { SalesforceSyncEnv } from "./env";
import { enqueueSyncSlot, handleSyncBatch, type SyncSlotMessage } from "./slot";

export type { SalesforceSyncEnv } from "./env";
export { SyncWorkflow } from "./workflow";

export default {
  scheduled(controller, env, ctx) {
    const message: SyncSlotMessage = {
      cron: controller.cron,
      scheduledTime: controller.scheduledTime,
    };
    ctx.waitUntil(enqueueSyncSlot(env, message));
  },
  queue(batch, env) {
    return handleSyncBatch(batch as MessageBatch<SyncSlotMessage>, env);
  },
  fetch() {
    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<SalesforceSyncEnv>;
