/**
 * Safe DOM helpers for the Config UI. Data never goes through innerHTML: templates hold constant
 * markup with data-slot placeholders, and values are written with textContent or DOM properties.
 */

/**
 * Fills placeholders under root. `data-slot="key"` gets textContent, `data-slot-value="key"` gets the
 * value property (and attribute), `data-slot-title="key"` gets the title attribute.
 * @param {Element} root
 * @param {Record<string, unknown>} values
 * @returns {Element} root
 */
function cuiFillSlots(root, values) {
  if (!root || !values) return root;
  for (const key of Object.keys(values)) {
    const raw = values[key];
    const text = raw === null || raw === undefined ? '' : String(raw);
    root.querySelectorAll(`[data-slot="${key}"]`).forEach((el) => {
      el.textContent = text;
    });
    root.querySelectorAll(`[data-slot-value="${key}"]`).forEach((el) => {
      el.value = text;
      el.setAttribute('value', text);
    });
    root.querySelectorAll(`[data-slot-title="${key}"]`).forEach((el) => {
      el.setAttribute('title', text);
    });
  }
  return root;
}

/**
 * Creates an element. opts: { className, text, attrs, on }. Children may be nodes or strings (text).
 * @param {string} tag
 * @param {{ className?: string, text?: unknown, attrs?: Record<string, unknown>, on?: Record<string, EventListener> }} [opts]
 * @param {...(Node|string|null|undefined|false)} children
 * @returns {HTMLElement}
 */
function cuiEl(tag, opts, ...children) {
  const el = document.createElement(tag);
  const o = opts || {};
  if (o.className) el.className = o.className;
  if (o.attrs) {
    for (const name of Object.keys(o.attrs)) {
      const value = o.attrs[name];
      if (value === false || value === null || value === undefined) continue;
      el.setAttribute(name, value === true ? '' : String(value));
    }
  }
  if (o.text !== undefined && o.text !== null) el.textContent = String(o.text);
  if (o.on) for (const type of Object.keys(o.on)) el.addEventListener(type, o.on[type]);
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return el;
}

if (typeof window !== 'undefined') {
  window.cuiFillSlots = cuiFillSlots;
  window.cuiEl = cuiEl;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { cuiFillSlots, cuiEl };
}
