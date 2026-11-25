// A small fake DOM for Config UI tests. Unlike the panel fakes, its innerHTML setter parses markup
// into real fake elements, so a test can prove that injected markup does (or does not) become an element.

type Listener = (event: FakeEvent) => void;

export interface FakeEvent {
  type: string;
  target: FakeElement | FakeDocument;
  currentTarget?: FakeElement | FakeDocument;
  defaultPrevented: boolean;
  preventDefault: () => void;
  stopPropagation: () => void;
  [key: string]: unknown;
}

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const RAW_TEXT_TAGS = new Set(['script', 'style', 'textarea', 'title']);

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_m, code: string) => {
    const lower = code.toLowerCase();
    if (lower === 'amp') return '&';
    if (lower === 'lt') return '<';
    if (lower === 'gt') return '>';
    if (lower === 'quot') return '"';
    if (lower === 'apos') return "'";
    if (lower === 'nbsp') return ' ';
    if (lower.startsWith('#x')) return String.fromCodePoint(parseInt(lower.slice(2), 16));
    return String.fromCodePoint(parseInt(lower.slice(1), 10));
  });
}

function escapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(text: string): string {
  return escapeText(text).replace(/"/g, '&quot;');
}

export class FakeText {
  parentNode: FakeElement | null = null;
  nodeType = 3;
  constructor(public data: string) {}
  get textContent(): string {
    return this.data;
  }
  set textContent(value: string) {
    this.data = String(value);
  }
  remove(): void {
    if (this.parentNode) this.parentNode.removeChild(this);
  }
}

export type FakeNode = FakeElement | FakeText;

interface SimpleSelector {
  tag?: string;
  id?: string;
  classes: string[];
  attrs: Array<{ name: string; value?: string }>;
  pseudo: string[];
}

function unescapeCss(text: string): string {
  return text.replace(/\\(.)/g, '$1');
}

function parseCompound(text: string): SimpleSelector {
  const sel: SimpleSelector = { classes: [], attrs: [], pseudo: [] };
  const re = /([a-z][a-z0-9-]*)|#((?:\\.|[\w-])+)|\.((?:\\.|[\w-])+)|\[([\w-]+)(?:="([^"]*)")?\]|(\*)|:(first-child|last-child)/giy;
  let index = 0;
  while (index < text.length) {
    re.lastIndex = index;
    const m = re.exec(text);
    if (!m) throw new Error(`html-fake-dom does not support selector ${text}`);
    if (m[1]) sel.tag = m[1].toLowerCase();
    else if (m[2]) sel.id = unescapeCss(m[2]);
    else if (m[3]) sel.classes.push(unescapeCss(m[3]));
    else if (m[4]) sel.attrs.push({ name: m[4], value: m[5] });
    else if (m[7]) sel.pseudo.push(m[7].toLowerCase());
    index = re.lastIndex;
  }
  return sel;
}

function matchesCompound(el: FakeElement, sel: SimpleSelector): boolean {
  if (sel.tag && el.tagName !== sel.tag) return false;
  if (sel.id && el.id !== sel.id) return false;
  const classes = el.className.split(/\s+/);
  for (const cls of sel.classes) if (!classes.includes(cls)) return false;
  for (const attr of sel.attrs) {
    if (!el.hasAttribute(attr.name)) return false;
    if (attr.value !== undefined && el.getAttribute(attr.name) !== attr.value) return false;
  }
  for (const pseudo of sel.pseudo) {
    const siblings = el.parentNode ? el.parentNode.children : [el];
    if (pseudo === 'first-child' && siblings[0] !== el) return false;
    if (pseudo === 'last-child' && siblings[siblings.length - 1] !== el) return false;
  }
  return true;
}

function matchesSelector(el: FakeElement, selector: string): boolean {
  return selector.split(',').some((part) => {
    const chain = part.trim().split(/\s+/).map(parseCompound);
    let current: FakeElement | null = el;
    if (!matchesCompound(current, chain[chain.length - 1]!)) return false;
    for (let i = chain.length - 2; i >= 0; i -= 1) {
      current = current ? current.parentNode : null;
      while (current && !matchesCompound(current, chain[i]!)) current = current.parentNode;
      if (!current) return false;
    }
    return true;
  });
}

export class FakeElement {
  parentNode: FakeElement | null = null;
  nodeType = 1;
  childNodes: FakeNode[] = [];
  attributes = new Map<string, string>();
  listeners = new Map<string, Listener[]>();
  style: Record<string, string> & { cssText?: string } = {};
  disabled = false;
  hidden = false;
  checked = false;
  draggable = false;
  open = false;
  returnValue = '';
  value = '';
  onclick: ((event: FakeEvent) => void) | null = null;
  scrollTop = 0;
  scrollHeight = 0;

  constructor(
    public tagName: string,
    public doc: FakeDocument,
  ) {}

  get className(): string {
    return this.attributes.get('class') ?? '';
  }
  set className(value: string) {
    this.attributes.set('class', String(value));
  }
  get id(): string {
    return this.attributes.get('id') ?? '';
  }
  set id(value: string) {
    this.attributes.set('id', String(value));
  }
  get title(): string {
    return this.attributes.get('title') ?? '';
  }
  set title(value: string) {
    this.attributes.set('title', String(value));
  }
  get type(): string {
    return this.attributes.get('type') ?? '';
  }
  set type(value: string) {
    this.attributes.set('type', String(value));
  }
  get href(): string {
    return this.attributes.get('href') ?? '';
  }
  set href(value: string) {
    this.attributes.set('href', String(value));
  }
  get src(): string {
    return this.attributes.get('src') ?? '';
  }
  set src(value: string) {
    this.attributes.set('src', String(value));
  }
  get alt(): string {
    return this.attributes.get('alt') ?? '';
  }
  set alt(value: string) {
    this.attributes.set('alt', String(value));
  }
  get placeholder(): string {
    return this.attributes.get('placeholder') ?? '';
  }
  set placeholder(value: string) {
    this.attributes.set('placeholder', String(value));
  }
  get readOnly(): boolean {
    return this.attributes.has('readonly');
  }
  set readOnly(value: boolean) {
    if (value) this.attributes.set('readonly', '');
    else this.attributes.delete('readonly');
  }
  get dataset(): Record<string, string> {
    const el = this;
    const toAttr = (key: string) => 'data-' + key.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
    return new Proxy({} as Record<string, string>, {
      get: (_t, key: string) => el.getAttribute(toAttr(key)) ?? undefined,
      set: (_t, key: string, value) => {
        el.setAttribute(toAttr(key), String(value));
        return true;
      },
    });
  }
  get classList() {
    const read = () => this.className.split(/\s+/).filter(Boolean);
    const write = (names: string[]) => {
      this.className = names.join(' ');
    };
    return {
      add: (...names: string[]) => write([...new Set([...read(), ...names])]),
      remove: (...names: string[]) => write(read().filter((n) => !names.includes(n))),
      toggle: (name: string, force?: boolean) => {
        const has = read().includes(name);
        const want = force === undefined ? !has : force;
        if (want && !has) write([...read(), name]);
        if (!want && has) write(read().filter((n) => n !== name));
        return want;
      },
      contains: (name: string) => read().includes(name),
    };
  }
  get children(): FakeElement[] {
    return this.childNodes.filter((n): n is FakeElement => n instanceof FakeElement);
  }
  get firstChild(): FakeNode | null {
    return this.childNodes[0] ?? null;
  }
  get lastChild(): FakeNode | null {
    return this.childNodes[this.childNodes.length - 1] ?? null;
  }
  get firstElementChild(): FakeElement | null {
    return this.children[0] ?? null;
  }
  get parentElement(): FakeElement | null {
    return this.parentNode;
  }
  get textContent(): string {
    return this.childNodes.map((n) => n.textContent).join('');
  }
  set textContent(value: string) {
    this.replaceChildren();
    if (value !== '' && value !== null && value !== undefined) this.appendChild(new FakeText(String(value)));
  }
  get innerText(): string {
    return this.textContent;
  }
  set innerText(value: string) {
    this.textContent = value;
  }
  get innerHTML(): string {
    return this.childNodes.map(serialize).join('');
  }
  set innerHTML(markup: string) {
    this.doc.innerHtmlWrites += 1;
    this.replaceChildren();
    parseInto(this, String(markup ?? ''));
  }
  insertAdjacentHTML(position: string, markup: string): void {
    this.doc.innerHtmlWrites += 1;
    const holder = new FakeElement('template', this.doc);
    parseInto(holder, markup);
    const nodes = [...holder.childNodes];
    if (position === 'beforeend') nodes.forEach((n) => this.appendChild(n));
    else if (position === 'afterbegin') nodes.reverse().forEach((n) => this.insertBefore(n, this.firstChild));
    else throw new Error(`html-fake-dom does not support insertAdjacentHTML(${position})`);
  }
  get isConnected(): boolean {
    return this.doc.documentElement.contains(this);
  }
  appendChild<T extends FakeNode>(node: T): T {
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }
  append(...nodes: Array<FakeNode | string>): void {
    for (const node of nodes) this.appendChild(typeof node === 'string' ? new FakeText(node) : node);
  }
  prepend(...nodes: Array<FakeNode | string>): void {
    const first = this.firstChild;
    for (const node of nodes) this.insertBefore(typeof node === 'string' ? new FakeText(node) : node, first);
  }
  insertBefore<T extends FakeNode>(node: T, ref: FakeNode | null): T {
    if (!ref) return this.appendChild(node);
    if (node.parentNode) node.parentNode.removeChild(node);
    const index = this.childNodes.indexOf(ref);
    node.parentNode = this;
    this.childNodes.splice(index < 0 ? this.childNodes.length : index, 0, node);
    return node;
  }
  removeChild<T extends FakeNode>(node: T): T {
    this.childNodes = this.childNodes.filter((n) => n !== node);
    node.parentNode = null;
    return node;
  }
  replaceChildren(...nodes: Array<FakeNode | string>): void {
    for (const node of this.childNodes) node.parentNode = null;
    this.childNodes = [];
    this.append(...nodes);
  }
  remove(): void {
    if (this.parentNode) this.parentNode.removeChild(this);
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name.toLowerCase(), String(value));
  }
  setAttributeNS(_ns: string | null, name: string, value: string): void {
    this.setAttribute(name, value);
  }
  getAttribute(name: string): string | null {
    const key = name.toLowerCase();
    return this.attributes.has(key) ? (this.attributes.get(key) as string) : null;
  }
  hasAttribute(name: string): boolean {
    return this.attributes.has(name.toLowerCase());
  }
  removeAttribute(name: string): void {
    this.attributes.delete(name.toLowerCase());
  }
  addEventListener(type: string, fn: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  removeEventListener(type: string, fn: Listener): void {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((l) => l !== fn),
    );
  }
  dispatch(type: string, extra: Record<string, unknown> = {}): FakeEvent {
    const event: FakeEvent = {
      type,
      target: this,
      currentTarget: this,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopPropagation() {},
      ...extra,
    };
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(event);
    if (type === 'click' && this.onclick) this.onclick(event);
    return event;
  }
  dispatchEvent(event: { type: string }): boolean {
    this.dispatch(event.type, event as Record<string, unknown>);
    return true;
  }
  click(): void {
    if (!this.disabled) this.dispatch('click');
  }
  focus(): void {
    this.doc.activeElement = this;
  }
  blur(): void {
    if (this.doc.activeElement === this) this.doc.activeElement = null;
  }
  select(): void {}
  scrollIntoView(): void {}
  getBoundingClientRect() {
    return { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
  }
  showModal(): void {
    this.open = true;
    const auto = this.querySelector('[autofocus]');
    if (auto) auto.focus();
  }
  show(): void {
    this.open = true;
  }
  close(value?: string): void {
    this.open = false;
    if (value !== undefined) this.returnValue = value;
    this.dispatch('close');
  }
  contains(node: FakeNode | null): boolean {
    let current: FakeNode | FakeElement | null = node;
    while (current) {
      if (current === this) return true;
      current = current.parentNode;
    }
    return false;
  }
  matches(selector: string): boolean {
    return matchesSelector(this, selector);
  }
  closest(selector: string): FakeElement | null {
    let current: FakeElement | null = this;
    while (current) {
      if (current.matches(selector)) return current;
      current = current.parentNode;
    }
    return null;
  }
  querySelectorAll(selector: string): FakeElement[] {
    const out: FakeElement[] = [];
    const walk = (el: FakeElement) => {
      for (const child of el.children) {
        if (child.matches(selector)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }
  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

function serialize(node: FakeNode): string {
  if (node instanceof FakeText) return escapeText(node.data);
  const attrs = [...node.attributes.entries()].map(([k, v]) => ` ${k}="${escapeAttr(v)}"`).join('');
  if (VOID_TAGS.has(node.tagName)) return `<${node.tagName}${attrs}>`;
  return `<${node.tagName}${attrs}>${node.childNodes.map(serialize).join('')}</${node.tagName}>`;
}

function parseAttributes(el: FakeElement, source: string): void {
  const re = /([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    const name = m[1]!.toLowerCase();
    const raw = m[2] ?? m[3] ?? m[4] ?? '';
    if (!el.attributes.has(name)) el.attributes.set(name, decodeEntities(raw));
  }
}

function parseInto(root: FakeElement, markup: string): void {
  const stack: FakeElement[] = [root];
  const top = () => stack[stack.length - 1]!;
  let i = 0;
  while (i < markup.length) {
    const lt = markup.indexOf('<', i);
    if (lt === -1) {
      top().appendChild(new FakeText(decodeEntities(markup.slice(i))));
      break;
    }
    if (lt > i) top().appendChild(new FakeText(decodeEntities(markup.slice(i, lt))));
    if (markup.startsWith('<!--', lt)) {
      const end = markup.indexOf('-->', lt + 4);
      i = end === -1 ? markup.length : end + 3;
      continue;
    }
    const close = /^<\/([a-zA-Z][\w-]*)\s*>/.exec(markup.slice(lt));
    if (close) {
      const name = close[1]!.toLowerCase();
      for (let s = stack.length - 1; s > 0; s -= 1) {
        if (stack[s]!.tagName === name) {
          stack.length = s;
          break;
        }
      }
      i = lt + close[0].length;
      continue;
    }
    const open = /^<([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/.exec(markup.slice(lt));
    if (!open) {
      top().appendChild(new FakeText('<'));
      i = lt + 1;
      continue;
    }
    const name = open[1]!.toLowerCase();
    let attrSource = open[2] ?? '';
    const selfClosing = /\/\s*$/.test(attrSource);
    if (selfClosing) attrSource = attrSource.replace(/\/\s*$/, '');
    const el = root.doc.createElement(name);
    parseAttributes(el, attrSource);
    top().appendChild(el);
    i = lt + open[0].length;
    if (RAW_TEXT_TAGS.has(name) && !selfClosing) {
      const end = markup.toLowerCase().indexOf(`</${name}`, i);
      const stop = end === -1 ? markup.length : end;
      if (stop > i) el.appendChild(new FakeText(name === 'textarea' || name === 'title' ? decodeEntities(markup.slice(i, stop)) : markup.slice(i, stop)));
      const gt = end === -1 ? markup.length : markup.indexOf('>', end);
      i = gt === -1 ? markup.length : gt + 1;
      continue;
    }
    if (!selfClosing && !VOID_TAGS.has(name)) stack.push(el);
  }
}

export class FakeDocument {
  created: string[] = [];
  innerHtmlWrites = 0;
  activeElement: FakeElement | null = null;
  documentElement: FakeElement;
  head: FakeElement;
  body: FakeElement;
  listeners = new Map<string, Listener[]>();
  readyState = 'loading';

  constructor() {
    this.documentElement = new FakeElement('html', this);
    this.head = new FakeElement('head', this);
    this.body = new FakeElement('body', this);
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
  }
  createElement(tag: string): FakeElement {
    this.created.push(tag.toLowerCase());
    return new FakeElement(tag.toLowerCase(), this);
  }
  createElementNS(_ns: string, tag: string): FakeElement {
    return this.createElement(tag);
  }
  createTextNode(text: string): FakeText {
    return new FakeText(String(text));
  }
  createDocumentFragment(): FakeElement {
    return new FakeElement('#fragment', this);
  }
  getElementById(id: string): FakeElement | null {
    const walk = (el: FakeElement): FakeElement | null => {
      for (const child of el.children) {
        if (child.id === id) return child;
        const found = walk(child);
        if (found) return found;
      }
      return null;
    };
    return walk(this.documentElement);
  }
  querySelector(selector: string): FakeElement | null {
    return this.documentElement.querySelector(selector);
  }
  querySelectorAll(selector: string): FakeElement[] {
    return this.documentElement.querySelectorAll(selector);
  }
  addEventListener(type: string, fn: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  removeEventListener(type: string, fn: Listener): void {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((l) => l !== fn),
    );
  }
  dispatch(type: string): void {
    if (type === 'DOMContentLoaded') this.readyState = 'interactive';
    const event: FakeEvent = {
      type,
      target: this,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopPropagation() {},
    };
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(event);
  }
}

/** Every element under root that injected markup could have created: an img with src x, or any element with an on* handler attribute holding the payload marker. */
export function injectedElements(root: FakeElement | FakeDocument, marker = 'PWNED('): FakeElement[] {
  const base = root instanceof FakeDocument ? root.documentElement : root;
  const all = [base, ...base.querySelectorAll('*')];
  return all.filter((el) => {
    if (el.tagName === 'img' && el.getAttribute('src') === 'x') return true;
    for (const [name, value] of el.attributes) if (name.startsWith('on') && value.includes(marker)) return true;
    return false;
  });
}

/** A payload that breaks out of text, double-quoted and single-quoted attribute contexts. */
export const XSS_PAYLOAD = `"'><img src=x onerror=PWNED(1)>`;

/** Returns the source of `function name(...) {...}` (optionally async) from a classic-script file. */
export function functionSource(source: string, name: string): string {
  const re = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const m = re.exec(source);
  if (!m) throw new Error(`function ${name} not found`);
  return blockFrom(source, m.index);
}

/** Returns source from `start` to the brace that closes the first block opened at or after it. */
export function blockFrom(source: string, start: number): string {
  const open = source.indexOf('{', start);
  let depth = 0;
  let quote: string | null = null;
  let templateDepth: number[] = [];
  for (let index = open; index < source.length; index += 1) {
    const char = source[index]!;
    const prev = source[index - 1];
    if (quote) {
      if (char === '\\') {
        index += 1;
        continue;
      }
      if (quote === '`' && char === '$' && source[index + 1] === '{') {
        templateDepth.push(depth);
        depth += 1;
        index += 1;
        quote = null;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }
    if (char === '/' && source[index + 1] === '/') {
      const nl = source.indexOf('\n', index);
      index = nl === -1 ? source.length : nl;
      continue;
    }
    if (char === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2);
      index = end === -1 ? source.length : end + 1;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (templateDepth.length && templateDepth[templateDepth.length - 1] === depth) {
        templateDepth.pop();
        quote = '`';
        continue;
      }
      if (depth === 0) return source.slice(start, index + 1);
    }
    void prev;
  }
  throw new Error('unbalanced block');
}
