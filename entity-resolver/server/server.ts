import { createApp, lakebase, server } from '@databricks/appkit';
import { agents } from '@databricks/appkit/beta';
import { helper } from './agents/helper';
import { evidenceFetcherAgent } from './agents/evidence-fetcher';
import { websiteValidatorAgent } from './agents/website-validator';
import { facebookValidatorAgent } from './agents/facebook-validator';
import { phoneValidatorAgent } from './agents/phone-validator';
import { locationValidatorAgent } from './agents/location-validator';
import { sourceAuthorityValidatorAgent } from './agents/source-authority-validator';
import { controlledVocabularyValidatorAgent } from './agents/controlled-vocabulary-validator';
import { contextValidatorAgent } from './agents/context-validator';
import { duplicateDetectorAgent } from './agents/duplicate-detector';
import { initSchema } from './routes/lakebase/schema';
import { setupResolutionRoutes } from './routes/lakebase/resolution-routes';
import { setupFacilitiesRoutes } from './routes/facilities-routes';
import type { LakebaseHandle, ServerHandle } from './plugin-handles';

createApp({
  plugins: [
    agents({
      agents: {
        helper,
        'evidence-fetcher': evidenceFetcherAgent,
        'website-validator': websiteValidatorAgent,
        'facebook-validator': facebookValidatorAgent,
        'phone-validator': phoneValidatorAgent,
        'location-validator': locationValidatorAgent,
        'source-authority-validator': sourceAuthorityValidatorAgent,
        'controlled-vocabulary-validator': controlledVocabularyValidatorAgent,
        'context-validator': contextValidatorAgent,
        'duplicate-detector': duplicateDetectorAgent,
      },
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
