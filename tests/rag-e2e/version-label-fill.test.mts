import { defineVersionLabelFillSuite } from './version-label-fill-suite.mts';

// Plan 05.2-21 (D-49): the title-marker label fill in multi-tenant mode; version-label-fill-single.test.mts runs the same suite single-tenant.
defineVersionLabelFillSuite('multi-tenant');
