export interface SalesforceSyncEnv extends Cloudflare.Env {
  SF_CLIENT_ID: string;
  SF_CLIENT_SECRET?: string;
  SF_REFRESH_TOKEN: string;
  GOOGLE_SERVICE_ACCOUNT_EMAIL?: string;
  GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?: string;
}
