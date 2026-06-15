import { createApp, lakebase, server, getWorkspaceClient } from '@databricks/appkit';
import { agents } from '@databricks/appkit/beta';
import { helper } from './agents/helper';
import { initSchema } from './routes/lakebase/schema';
import { setupResolutionRoutes } from './routes/lakebase/resolution-routes';
import { setupFacilitiesRoutes } from './routes/facilities-routes';
import type { LakebaseHandle, ServerHandle } from './plugin-handles';

// Databricks token for SQL warehouse queries — refreshed on every call.
// Uses the SDK auth chain: DATABRICKS_TOKEN in prod (Apps injects it),
// ~/.databrickscfg profile locally. Never shells out to the CLI.
async function getDatabricksToken(): Promise<string> {
  const client = getWorkspaceClient({});
  const headers = new Headers();
  await client.config.authenticate(headers);
  const auth = headers.get('Authorization') ?? '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (!token) throw new Error('Could not resolve Databricks token from SDK auth chain');
  return token;
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
    const lb = appkit.lakebase as LakebaseHandle;
    const srv = appkit.server as ServerHandle;

    await initSchema(lb);
    setupResolutionRoutes(lb, srv);

    srv.extend((app) => {
      setupFacilitiesRoutes(app, getDatabricksToken);
    });
  },
}).catch(console.error);
