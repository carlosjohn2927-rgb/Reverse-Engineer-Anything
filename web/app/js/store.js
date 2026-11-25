/** Minimal observable store shared by every view. */

/** @type {Set<(change: Record<string, unknown>) => void>} */
const listeners = new Set();

/**
 * One advertised REA tool, as `tools/list` returns it plus web annotations.
 *
 * @typedef {{
 *   name: string,
 *   title?: string,
 *   description?: string,
 *   cli?: string,
 *   hostDependent?: boolean,
 *   annotations?: {
 *     readOnlyHint?: boolean,
 *     destructiveHint?: boolean,
 *     idempotentHint?: boolean,
 *     openWorldHint?: boolean,
 *   } | null,
 *   inputSchema?: { type?: string, properties?: Record<string, any>, required?: string[] },
 * }} Tool
 */

/**
 * One advertised MCP prompt: REA's instructions for a situation, with
 * arguments the caller fills in.
 *
 * @typedef {{
 *   name: string,
 *   title?: string,
 *   description?: string,
 *   arguments?: { name: string, description?: string, required?: boolean }[],
 * }} Prompt
 */

/**
 * One inspection subject: an uploaded file, generated sample or folder.
 *
 * @typedef {{
 *   id: string,
 *   name: string,
 *   path: string,
 *   kind?: string,
 *   bytes?: number,
 *   sha256?: string,
 *   sample?: string,
 * }} Target
 */

/**
 * One recorded tool result, shown in the Evidence view.
 *
 * @typedef {{
 *   id: string,
 *   at: number,
 *   tool: string,
 *   status?: string,
 *   payload?: any,
 *   error?: any,
 *   durationMs?: number,
 *   subject?: string,
 *   evidenceId?: string,
 * }} Entry
 */

/**
 * @typedef {{
 *   view: string,
 *   status: any,
 *   doctor: any,
 *   capabilities: any,
 *   hostIntegrations: any,
 *   operationReadiness: Map<string, { available: boolean, code: string | null, provider: string, reason: string | null }>,
 *   tools: Tool[],
 *   toolsByName: Map<string, Tool>,
 *   prompts: Prompt[],
 *   instructions: string,
 *   sessionReady: boolean,
 *   sessionError: string | null,
 *   targets: Target[],
 *   selectedTarget: Target | null,
 *   evidence: Entry[],
 *   activity: Entry[],
 *   running: Map<string, AbortController>,
 *   theme: string,
 *   paletteOpen: boolean,
 *   drawerTool: string | null,
 *   upload: { active: boolean } | null,
 *   toolFamily: string,
 *   toolSearch: string,
 *   evidenceSearch: string,
 *   lastTree: any[],
 * }} State
 */

/** @type {State} */
export const state = {
  view: "workspace",
  status: null,
  doctor: null,
  capabilities: null,
  hostIntegrations: null,
  operationReadiness: new Map(),
  tools: [],
  toolsByName: new Map(),
  prompts: [],
  instructions: "",
  sessionReady: false,
  sessionError: null,
  targets: [],
  selectedTarget: null,
  evidence: [],
  activity: [],
  running: new Map(),
  theme: localStorage.getItem("rea-theme") ?? "dark",
  paletteOpen: false,
  drawerTool: null,
  upload: null,
  toolFamily: "all",
  toolSearch: "",
  evidenceSearch: "",
  lastTree: [],
};

/**
 * @param {(change: Record<string, unknown>) => void} listener
 * @returns {() => void} unsubscribe
 */
export const subscribe = (listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** @param {Record<string, unknown>} [change] */
export const notify = (change = {}) => {
  for (const listener of listeners) listener(change);
};

/** @param {Partial<State>} patch */
export const set = (patch) => {
  Object.assign(state, patch);
  notify(patch);
};

/**
 * Append an activity entry (newest first), bounded to 200 entries.
 *
 * @param {Partial<Entry> & { tool: string }} entry
 * @returns {Entry}
 */
export const recordActivity = (entry) => {
  /** @type {Entry} */
  const record = { id: crypto.randomUUID(), at: Date.now(), ...entry };
  state.activity.unshift(record);
  if (state.activity.length > 200) state.activity.length = 200;
  notify({ activity: true });
  return record;
};

/**
 * Register a completed evidence-bearing result for the Evidence view.
 *
 * @param {Partial<Entry> & { tool: string }} entry
 * @returns {Entry}
 */
export const recordEvidence = (entry) => {
  /** @type {Entry} */
  const record = { id: crypto.randomUUID(), at: Date.now(), ...entry };
  state.evidence.unshift(record);
  if (state.evidence.length > 100) state.evidence.length = 100;
  notify({ evidence: true });
  return record;
};

/**
 * Add or refresh a target; returns the stored target (never a key).
 *
 * @param {Omit<Target, "id"> & { id?: string }} target
 * @returns {Target}
 */
export const addTarget = (target) => {
  const key = target.path ?? target.name;
  const existing = state.targets.find(
    (candidate) => (candidate.path ?? candidate.name) === key,
  );
  if (existing !== undefined) {
    Object.assign(existing, target);
    notify({ targets: true });
    return existing;
  }
  const stored = { id: crypto.randomUUID(), ...target };
  state.targets.unshift(stored);
  notify({ targets: true });
  return stored;
};

/** @param {string} path */
export const findTarget = (path) =>
  state.targets.find((target) => (target.path ?? target.name) === path);

/** @param {string} key */
export const removeTarget = (key) => {
  state.targets = state.targets.filter(
    (target) => (target.path ?? target.name) !== key,
  );
  if ((state.selectedTarget?.path ?? state.selectedTarget?.name) === key)
    state.selectedTarget = null;
  notify({ targets: true });
};

/** @param {Target | null} target */
export const setSelectedTarget = (target) => {
  state.selectedTarget = target;
  notify({ selectedTarget: true });
};

/** @param {string} key */
export const isRunning = (key) => state.running.has(key);
