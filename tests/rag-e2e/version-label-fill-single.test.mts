import { defineVersionLabelFillSuite } from './version-label-fill-suite.mts';

// Plan 05.2-21 (D-49): the title-marker label fill in single-tenant mode (a separate process: the deployment mode is read at import).
defineVersionLabelFillSuite('single-tenant');
