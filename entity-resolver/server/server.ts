import { createApp, lakebase, server } from '@databricks/appkit';
import { agents } from '@databricks/appkit/beta';
import { helper } from './agents/helper';
import { websiteValidatorAgent } from './agents/website-validator';
import { facebookValidatorAgent } from './agents/facebook-validator';
import { phoneValidatorAgent } from './agents/phone-validator';
import { initSchema } from './routes/lakebase/schema';
import { setupResolutionRoutes } from './routes/lakebase/resolution-routes';
import { setupFacilitiesRoutes } from './routes/facilities-routes';
import type { LakebaseHandle, ServerHandle } from './plugin-handles';

createApp({
  plugins: [
    agents({
      agents: { helper, websiteValidatorAgent, facebookValidatorAgent, phoneValidatorAgent },
    }),
    lakebase(),
    server(),
  ],
  async onPluginsReady(appkit) {
    const lb = appkit.lakebase as LakebaseHandle;
    const srv = appkit.server as ServerHandle;

    await initSchema(lb);
    setupResolutionRoutes(lb, srv);
    setupFacilitiesRoutes(lb, srv);
  },
}).catch(console.error);
