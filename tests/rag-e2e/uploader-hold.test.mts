import { UPLOADER_HOLD_MODES, runUploaderHoldSuite } from './uploader-hold-suite.mts';

// Plan 05.2-17 (D-46), multi-tenant: the uploader hold on the unified path. The single-tenant run is uploader-hold-single.test.mts (one
// process per deployment mode, since the Supabase admin client keeps the first fake edge it saw).
runUploaderHoldSuite(UPLOADER_HOLD_MODES.multi);
