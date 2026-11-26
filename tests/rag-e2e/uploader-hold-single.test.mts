import { UPLOADER_HOLD_MODES, runUploaderHoldSuite } from './uploader-hold-suite.mts';

// Plan 05.2-17 (D-46), single-tenant: the uploader hold on the unified path.
runUploaderHoldSuite(UPLOADER_HOLD_MODES.single);
