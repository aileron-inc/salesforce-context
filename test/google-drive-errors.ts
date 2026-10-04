const QUOTA_MESSAGE =
  "User Rate Limit Exceeded. Rate of requests for user exceed configured project quota. You may consider re-evaluating expected per-user traffic to the API and adjust project quota limits accordingly. You may monitor aggregate quota usage and adjust limits in the API Console: https://console.developers.google.com/apis/api/drive.googleapis.com/quotas?project=123456789012. ";

export function longUserRateLimitBody(): string {
  const message = QUOTA_MESSAGE.repeat(2);
  return JSON.stringify({
    error: {
      code: 403,
      message,
      errors: [
        {
          domain: "usageLimits",
          message,
          reason: "userRateLimitExceeded",
        },
      ],
    },
  });
}

export function longRpcRateLimitBody(): string {
  const message =
    "Quota exceeded for quota metric 'Queries' and limit 'Queries per minute' of service 'drive.googleapis.com' for consumer 'project_number:123456789012'. " +
    QUOTA_MESSAGE;
  return JSON.stringify({
    error: {
      code: 403,
      message,
      status: "RESOURCE_EXHAUSTED",
      details: [
        {
          "@type": "type.googleapis.com/google.rpc.ErrorInfo",
          reason: "RATE_LIMIT_EXCEEDED",
          domain: "googleapis.com",
          metadata: {
            consumer: "projects/123456789012",
            quota_limit: "defaultPerMinutePerUser",
            quota_metric: "drive.googleapis.com/default",
            service: "drive.googleapis.com",
          },
        },
        {
          "@type": "type.googleapis.com/google.rpc.Help",
          links: [
            {
              description: "Request a quota increase",
              url: "https://cloud.google.com/docs/quotas/help/request_increase",
            },
          ],
        },
      ],
    },
  });
}

export function permissionDeniedRateLimitBody(options?: { details?: boolean }): string {
  const message = QUOTA_MESSAGE.repeat(2);
  const error: Record<string, unknown> = {
    code: 403,
    message,
    status: "PERMISSION_DENIED",
    errors: [
      {
        domain: "usageLimits",
        message,
        reason: "rateLimitExceeded",
      },
    ],
  };
  if (options?.details) {
    error.details = [
      {
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        reason: "rateLimitExceeded",
        domain: "googleapis.com",
        metadata: {
          quota_limit: "defaultPerMinutePerProject",
          service: "drive.googleapis.com",
        },
      },
    ];
  }
  return JSON.stringify({ error });
}

export function longErrorsReasonBody(reason: string): string {
  const message = "x".repeat(500);
  return JSON.stringify({
    error: {
      code: 403,
      message,
      errors: [{ domain: "global", message, reason }],
    },
  });
}

export function longRpcReasonBody(reason: string): string {
  const message = "The caller does not have permission for this file. ".repeat(12);
  return JSON.stringify({
    error: {
      code: 403,
      message,
      details: [
        {
          "@type": "type.googleapis.com/google.rpc.ErrorInfo",
          reason,
          domain: "drive.googleapis.com",
          metadata: { service: "drive.googleapis.com" },
        },
      ],
    },
  });
}
