import { createApp, lakebase, server } from '@databricks/appkit';
import { agents } from '@databricks/appkit/beta';
import { helper } from './agents/helper';
import { initSchema } from './routes/lakebase/schema';
import { setupResolutionRoutes } from './routes/lakebase/resolution-routes';
import { setupFacilitiesRoutes } from './routes/facilities-routes';
import type { AppKitWithLakebase } from './types';

// Databricks OAuth token for SQL warehouse queries (refreshed per-request)
async function getDatabricksToken(): Promise<string> {
  // In Databricks Apps, the platform injects DATABRICKS_TOKEN automatically.
  // Locally, the CLI profile token is used via the SDK.
  const envToken = process.env.DATABRICKS_TOKEN;
  if (envToken) return envToken;

  // Fallback: use the CLI profile token (local dev only)
  const { execSync } = await import('child_process');
  const raw = execSync(
    'databricks auth token --profile MARKETPLACE --output json 2>/dev/null',
    { encoding: 'utf-8' },
  );
  const idx = raw.indexOf('{');
  return JSON.parse(raw.slice(idx)).access_token as string;
}

createApp({
  plugins: [
    agents({
      agents: { helper },
    }),
    lakebase(),
    server(),
  ],
  async onPluginsReady(appkit) {
    // Initialize Lakebase schema
    await initSchema(appkit as unknown as AppKitWithLakebase);

    // Register Lakebase-backed resolution routes
    setupResolutionRoutes(appkit as unknown as AppKitWithLakebase);

    // Register SQL warehouse-backed facilities routes
    (appkit as unknown as AppKitWithLakebase).server.extend((app) => {
      setupFacilitiesRoutes(app, getDatabricksToken);
    });
  },
}).catch(console.error);
