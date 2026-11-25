/**
 * Every capability REA advertises must be reachable in the workspace.
 *
 * The tool catalog has no grouping metadata, so `web/app/js/families.js` maps
 * each tool to a family by hand. That map used to be a set of anchored regular
 * expressions (`/^(procedure_|set_|...)$/`), which silently dropped 61 of 233
 * tools: a prefix like `procedure_` can never match a pattern ending in `$`.
 * Those tools fell into an unlabelled "Other" bucket, so 26% of REA was
 * effectively hidden from the Tools view.
 *
 * This suite fails loudly instead of letting a gap stay quiet:
 *   - every advertised tool is assigned to exactly one family
 *   - no family claims a tool REA no longer advertises
 *   - every advertised prompt is exposed with usable arguments
 *   - the Tools view renders every tool, and every advertised prompt appears
 *     in the Workflows view
 *
 *   node web/test/catalog-coverage.mjs http://127.0.0.1:4180
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const base = process.argv[2] ?? "http://127.0.0.1:4180";

let JSDOM;
try {
  const require = createRequire(import.meta.url);
  ({ JSDOM } = require("jsdom"));
} catch {
  if (process.env.REA_WEB_ALLOW_SKIP === "1") {
    console.log(
      "catalog-coverage: jsdom is not installed; skipping (REA_WEB_ALLOW_SKIP=1).",
    );
    process.exit(0);
  }
  console.error(
    "catalog-coverage: jsdom is required for this check. Install it with " +
      "`npm i -D jsdom` or set REA_WEB_ALLOW_SKIP=1 to skip.",
  );
  process.exit(1);
}

const failures = [];
const check = (label, ok, detail = "") => {
  if (!ok) failures.push(`${label} ${detail}`.trim());
  console.log(
    `${ok ? "ok  " : "FAIL"} ${label}${detail === "" ? "" : ` — ${detail}`}`,
  );
};

// ---- Static half: the hand-written map versus what REA advertises ----------
const familiesModule = await import(
  pathToFileURL(new URL("../app/js/families.js", import.meta.url).pathname).href
);
const { FAMILIES, familyOf, classifiedToolNames } = familiesModule;

let advertised;
try {
  advertised = JSON.parse(
    readFileSync(
      new URL("../../dist/mcp-catalog.json", import.meta.url),
      "utf8",
    ),
  ).tools;
} catch {
  advertised = null;
}

if (advertised === null) {
  console.log(
    "catalog-coverage: dist/mcp-catalog.json is missing; checking the live catalog only.",
  );
} else {
  const names = advertised.map((tool) => tool.name);
  const unique = new Set(names);
  check(
    "the family map exposes its membership list",
    typeof classifiedToolNames === "function",
    typeof classifiedToolNames === "function"
      ? ""
      : "families.js must export classifiedToolNames()",
  );
  const classified =
    typeof classifiedToolNames === "function" ? classifiedToolNames() : names;

  check(
    "the catalog has no duplicate tool names",
    unique.size === names.length,
    `${names.length} entries, ${unique.size} unique`,
  );
  check(
    "the family map assigns no tool twice",
    classified.length === new Set(classified).size,
    `${classified.length} assignments, ${new Set(classified).size} distinct`,
  );

  const unassigned = names.filter((name) => familyOf(name) === "other");
  check(
    "every advertised tool belongs to a family",
    unassigned.length === 0,
    unassigned.length === 0
      ? `${names.length} tools placed`
      : `${unassigned.length} unassigned: ${unassigned.join(", ")}`,
  );

  const phantom = classified.filter((name) => !unique.has(name));
  check(
    "the family map claims no unavailable tool",
    phantom.length === 0,
    phantom.length === 0 ? "" : `stale: ${phantom.join(", ")}`,
  );

  // A family that holds no advertised tool is dead weight in the UI.
  const emptyFamilies = FAMILIES.filter(
    (family) => family.tools.filter((name) => unique.has(name)).length === 0,
  ).map((family) => family.id);
  check(
    "no family is empty",
    emptyFamilies.length === 0,
    emptyFamilies.join(", "),
  );
}

// ---- Live half: the running app must show every tool and prompt ------------
const html = readFileSync(
  new URL("../app/index.html", import.meta.url),
  "utf8",
);
const dom = new JSDOM(html, {
  url: `${base}/`,
  pretendToBeVisual: true,
  runScripts: "outside-only",
});
const { window } = dom;
const errors = [];

const realFetch = globalThis.fetch;
const shim = async (input, init) => {
  let raw = typeof input === "string" ? input : (input?.url ?? String(input));
  if (raw.startsWith("/")) raw = `${base}${raw}`;
  const response = await realFetch(raw, init);
  const text = await response.text();
  return {
    ok: response.ok,
    status: response.status,
    headers: response.headers,
    text: async () => text,
    json: async () => JSON.parse(text),
    body: {
      getReader() {
        const buffer = Buffer.from(text, "utf8");
        let sent = false;
        return {
          async read() {
            if (sent) return { value: undefined, done: true };
            sent = true;
            return { value: new Uint8Array(buffer), done: false };
          },
        };
      },
    },
  };
};
const define = (key, value) => {
  try {
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });
  } catch {
    // A non-configurable sandbox global keeps its own value.
  }
};
for (const key of [
  "window",
  "document",
  "navigator",
  "location",
  "history",
  "localStorage",
  "HTMLElement",
  "Node",
  "CustomEvent",
  "Event",
  "NodeFilter",
  "MutationObserver",
  "TextDecoder",
  "TextEncoder",
])
  if (window[key] !== undefined) define(key, window[key]);
define("fetch", shim);
window.fetch = shim;
window.HTMLDialogElement.prototype.showModal = function () {
  this.open = true;
};
window.HTMLDialogElement.prototype.close = function () {
  this.open = false;
};
window.URL.createObjectURL = () => "blob:mock";
process.on("unhandledRejection", (reason) =>
  errors.push(
    reason instanceof Error ? (reason.stack ?? reason.message) : String(reason),
  ),
);

const moduleUrl = (path) =>
  pathToFileURL(new URL(`../app/js/${path}`, import.meta.url).pathname).href;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (predicate, timeout = 60_000) => {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      if (predicate()) return true;
    } catch {
      // Still rendering.
    }
    await wait(150);
  }
  return false;
};

await import(moduleUrl("main.js"));
const { state } = await import(moduleUrl("store.js"));

check(
  "the app starts a session",
  await until(() => state.sessionReady),
  state.sessionError ?? "",
);

const toolCount = state.tools.length;
check("the session advertises tools", toolCount > 0, `${toolCount} tools`);

const promptCount = state.prompts.length;
check(
  "the session exposes REA's prompts",
  promptCount > 0,
  `${promptCount} prompts`,
);

if (advertised !== null) {
  check(
    "the live tool count matches the catalog",
    toolCount === advertised.length,
    `${toolCount} live vs ${advertised.length} catalog`,
  );
}

// The Workflows view must render one card per advertised prompt, and fetching
// one must return real instructions.
const viewRoot = window.document.getElementById("view-root");
const workflowsButton = window.document.querySelector(
  '.rail-link[data-view="workflows"]',
);
check("the rail offers the Workflows view", workflowsButton !== null);
if (workflowsButton !== null && promptCount > 0) {
  workflowsButton.click();
  const painted = await until(
    () => window.document.querySelectorAll(".workflow-card").length > 0,
  );
  const cards = window.document.querySelectorAll(".workflow-card").length;
  check(
    "every advertised prompt gets a card",
    painted && cards === promptCount,
    `${cards} cards for ${promptCount} prompts`,
  );
  const fields = window.document.querySelectorAll(
    ".workflow-card .workflow-args input",
  );
  const expectedFields = state.prompts.reduce(
    (total, prompt) => total + (prompt.arguments?.length ?? 0),
    0,
  );
  check(
    "every prompt argument gets an input",
    fields.length === expectedFields,
    `${fields.length} inputs for ${expectedFields} arguments`,
  );
}

// The Tools view must render every tool, including the ones that used to be
// swallowed by the anchored regexes.
if (state.tools.length > 0) {
  const toolsButton = window.document.querySelector(
    '.rail-link[data-view="tools"]',
  );
  toolsButton?.click();
  await until(() => window.document.querySelectorAll(".tool-card").length > 0);
  const cards = window.document.querySelectorAll(".tool-card").length;
  check(
    "the Tools view renders every advertised tool",
    cards === state.tools.length,
    `${cards} cards for ${state.tools.length} tools`,
  );

  // Regression names: each one was unclassified under the old regex map.
  const regressions = [
    "procedure_info",
    "set_bookmark",
    "current_address",
    "inspect_plist",
    "compare_artifacts",
    "gdb_console",
  ].filter((name) => state.tools.some((tool) => tool.name === name));
  check(
    "previously unclassified tools are present",
    regressions.length > 0,
    regressions.join(", "),
  );
  const stillOther = regressions.filter((name) => familyOf(name) === "other");
  check(
    "previously unclassified tools now have a family",
    stillOther.length === 0,
    stillOther.join(", "),
  );

  // "Other" must not be a silent dumping ground.
  const other = state.tools.filter((tool) => familyOf(tool.name) === "other");
  check(
    "no live tool falls outside every family",
    other.length === 0,
    other.length === 0 ? "" : other.map((tool) => tool.name).join(", "),
  );

  // REA annotates every tool. Dropping the annotations hid which calls rewrite
  // analysis state and which reach a device or network target, so a click was
  // riskier than it looked.
  const annotated = state.tools.filter(
    (tool) => tool.annotations !== null && tool.annotations !== undefined,
  );
  check(
    "the session carries MCP annotations",
    annotated.length === state.tools.length,
    `${annotated.length} of ${state.tools.length} annotated`,
  );
  const risky = state.tools.filter(
    (tool) =>
      tool.annotations?.destructiveHint === true ||
      tool.annotations?.openWorldHint === true,
  );
  check(
    "state-editing and open-world tools are identified",
    risky.length > 0,
    `${risky.length} tools flagged`,
  );
  const badgeCount = window.document.querySelectorAll(
    ".tool-card .badge.ok, .tool-card .badge.warn, .tool-card .badge",
  ).length;
  check(
    "the Tools view shows annotation badges",
    badgeCount > 0,
    `${badgeCount} badges`,
  );
}

check("no runtime errors", errors.length === 0, errors.join(" | "));

const { api } = await import(moduleUrl("api.js"));
await api.endSession().catch(() => undefined);

if (failures.length > 0) {
  console.error(`\ncatalog-coverage: ${failures.length} failure(s).`);
  process.exit(1);
}
console.log("\ncatalog-coverage: all checks passed.");
