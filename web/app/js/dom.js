/**
 * @typedef {string | number | boolean | null | undefined | Node} Child
 */

/**
 * @typedef {Record<string, unknown> & {
 *   class?: string,
 *   text?: string,
 *   html?: string,
 *   dataset?: Record<string, string>,
 *   [key: `on${string}`]: ((event: Event) => void) | undefined,
 * }} Attributes
 */

/**
 * Tiny DOM builder. Returns a real element; children may be nodes or strings.
 * Attributes starting with `on` bind event listeners; `dataset` sets data
 * attributes; `class`, `html` and `text` are handled specially.
 *
 * @param {string} tag
 * @param {Attributes} [attributes]
 * @param {...(Child | Child[])} children
 * @returns {HTMLElement}
 */
export const h = (tag, attributes = {}, ...children) => {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") element.className = String(value);
    else if (key === "dataset") Object.assign(element.dataset, value);
    else if (key === "html") element.innerHTML = String(value);
    else if (key === "text") element.textContent = String(value);
    else if (key.startsWith("on") && typeof value === "function")
      element.addEventListener(
        key.slice(2).toLowerCase(),
        /** @type {EventListener} */ (value),
      );
    else if (value === true) element.setAttribute(key, "");
    else element.setAttribute(key, String(value));
  }
  append(element, children);
  return element;
};

/**
 * @param {Node} parent
 * @param {readonly (Child | Child[])[]} children
 */
const append = (parent, children) => {
  /** @type {Node} */
  const target = parent;
  for (const child of children.flat(Infinity)) {
    if (child === undefined || child === null || child === false) continue;
    target.appendChild(
      child instanceof Node ? child : document.createTextNode(String(child)),
    );
  }
};

/**
 * Look up a required element by id. The shell always ships these nodes, so a
 * miss is a programming error rather than a case every call site must handle.
 *
 * @param {string} id
 * @returns {HTMLElement}
 */
export const byId = (id) => {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`Missing element #${id}`);
  return element;
};

/**
 * Read a form control with the element type it actually has.
 *
 * @param {string} id
 * @returns {HTMLInputElement}
 */
export const inputById = (id) => /** @type {HTMLInputElement} */ (byId(id));

/**
 * Read a dialog element (`showModal`, `open`, `close`).
 *
 * @param {string} id
 * @returns {HTMLDialogElement}
 */
export const dialogById = (id) => /** @type {HTMLDialogElement} */ (byId(id));

/**
 * Narrow an event target to the input that fired it.
 *
 * @param {Event} event
 * @returns {HTMLInputElement}
 */
export const inputOf = (event) =>
  /** @type {HTMLInputElement} */ (event.target);

/**
 * Message text for any thrown value.
 *
 * @param {unknown} error
 * @returns {string}
 */
export const errorMessage = (error) =>
  error instanceof Error ? error.message : String(error);

/**
 * SVG builder (namespaced, so `class` must be set as an attribute).
 *
 * @param {string} tag
 * @param {Record<string, unknown>} [attributes]
 * @param {...(Child | Child[])} children
 * @returns {SVGElement}
 */
export const svg = (tag, attributes = {}, ...children) => {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attributes ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child === undefined || child === null || child === false) continue;
    node.append(
      child instanceof Node ? child : document.createTextNode(String(child)),
    );
  }
  return node;
};

/**
 * Replace every child of a node.
 *
 * @param {Element} node
 * @param {...(Child | Child[])} children
 */
export const replaceChildren = (node, ...children) => {
  node.replaceChildren();
  append(node, children);
};

/**
 * Format bytes with binary units.
 *
 * @param {number} bytes
 * @returns {string}
 */
export const formatBytes = (bytes) => {
  if (typeof bytes !== "number" || !Number.isFinite(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[unit] ?? "B"}`;
};

/**
 * Format a duration in milliseconds.
 *
 * @param {number | undefined} milliseconds
 * @returns {string}
 */
export const formatDuration = (milliseconds) => {
  if (typeof milliseconds !== "number") return "—";
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1000).toFixed(1)} s`;
  return `${Math.floor(milliseconds / 60_000)}m ${Math.round((milliseconds % 60_000) / 1000)}s`;
};

/**
 * Copy text, preferring the async clipboard API.
 *
 * @param {string} text
 * @returns {Promise<boolean>}
 */
export const copyText = async (text) => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  }
};

/**
 * Pretty-print a JSON value.
 *
 * @param {unknown} value
 * @returns {string}
 */
export const prettyJson = (value) => {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

/**
 * Human label for an MCP tool name (`inspect_go_binary` -> `Inspect go binary`).
 *
 * @param {string | undefined} name
 * @returns {string}
 */
export const humanize = (name) =>
  String(name ?? "")
    .replaceAll("_", " ")
    .replace(/\b\w/gu, (character) => character.toUpperCase());
