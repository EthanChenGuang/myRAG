/** Glossary view of the Terminology panel (06.2 UI-SPEC 6.2). Stub: implemented in the next commit. */

const GLOSSARY_LABELS = { en: {}, zh: {}, it: {} };

function initGlossaryView() {
  return null;
}

if (typeof window !== 'undefined') {
  window.GLOSSARY_LABELS = GLOSSARY_LABELS;
  window.initGlossaryView = initGlossaryView;
}
