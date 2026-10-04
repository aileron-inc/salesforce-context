export function log(fields: Record<string, unknown>): void {
  console.log(JSON.stringify(fields));
}

export function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").trim().slice(0, 500);
}
