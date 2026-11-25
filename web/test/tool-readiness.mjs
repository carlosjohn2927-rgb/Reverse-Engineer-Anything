/**
 * A tool that cannot run here must look different from one REA never mentioned.
 *
 * REA reports availability per operation group, and only for providers it can
 * inspect without a live target. `capabilities` is a CLI command — asking over
 * MCP answers -32602 — so the data is always read with no target open. The
 * consequence this suite protects is the *asymmetry*:
 *
 *   - "unavailable" is trustworthy: REA named the operation and said it cannot
 *     run (`unsupported_host` on the ten macOS-only ones in this sandbox);
 *   - "available" is a floor, because runtime state was not in view;
 *   - silence covers most of the catalog and must never render as a verdict.
 *
 * The failure mode this guards against is a badge that colours 214 unverified
 * tools green, turning "REA said nothing" into "this works".
 *
 *   node web/test/tool-readiness.mjs http://127.0.0.1:4180
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
      "tool-readiness: jsdom is not installed; skipping (REA_WEB_ALLOW_SKIP=1).",
    );
    process.exit(0);
  }
  console.error(
    "tool-readiness: jsdom is required for this check. Install it with " +
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

// ---- The projection, as a pure unit -------------------------------------
const {
  readinessFromCapabilities,
  readinessFor,
  readinessTally,
  readinessSummary,
} = await import(
  pathToFileURL(new URL("../app/js/readiness.js", import.meta.url).pathname)
    .href
);

const sample = {
  capabilities: [
    {
      provider: { id: "mx" },
      groups: [
        {
          operations: ["a_one", "a_two"],
          available: false,
          availability_code: "unsupported_host",
          reason: "Requires macOS.",
        },
      ],
    },
    {
      provider: { id: "okp" },
      groups: [{ operations: ["b_one"], available: true }],
    },
    {
      provider: { id: "shared" },
      groups: [
        {
          operations: ["both"],
          available: false,
          availability_code: "unsupported_host",
        },
      ],
    },
    {
      provider: { id: "also" },
      groups: [{ operations: ["both"], available: true }],
    },
  ],
};
const projected = readinessFromCapabilities(sample);

check(
  "projection indexes every operation",
  projected.size === 4,
  `${projected.size} entries`,
);
check(
  "a single available provider wins over another unavailable one",
  readinessFor(projected, "both")?.available === true,
  `both -> ${readinessFor(projected, "both")?.provider}`,
);
check(
  "an unavailable operation keeps its code and provider",
  readinessFor(projected, "a_one")?.code === "unsupported_host" &&
    readinessFor(projected, "a_one")?.provider === "mx",
);
check(
  "an operation REA never mentioned is null, not false",
  readinessFor(projected, "never_heard_of") === null,
);
check(
  "the summary states the consequence, not just the state",
  readinessSummary(readinessFor(projected, "a_one")).includes(
    "Requires macOS.",
  ),
);

// Tally must keep "unknown" as its own bucket.
const tally = readinessTally(
  ["a_one", "both", "ghost_1", "ghost_2"],
  projected,
);
check(
  "the tally separates unverified from unavailable",
  tally.unavailable === 1 && tally.available === 1 && tally.unverified === 2,
  JSON.stringify(tally),
);

// A payload that failed to parse must not fabricate readiness.
check(
  "an empty payload yields no readiness",
  readinessFromCapabilities({ capabilities: [] }).size === 0,
);
check(
  "a malformed payload yields no readiness",
  readinessFromCapabilities(null).size === 0 &&
    readinessFromCapabilities({ unavailable_reason: "boom" }).size === 0,
);

// ---- The live data -------------------------------------------------------
const session = await fetch(`${base}/api/sessions`, { method: "POST" }).then(
  (response) => response.json(),
);
const headers = {
  "content-type": "application/json",
  "x-rea-session": session.sessionId,
};
const payload = await fetch(`${base}/api/capabilities`, {
  method: "POST",
  headers,
  body: JSON.stringify({}),
}).then((response) => response.json());
const live = readinessFromCapabilities(payload);

const toolNames = session.tools.map((tool) => tool.name);
const liveTally = readinessTally(toolNames, live);
check(
  "the live catalog is mostly unverified",
  liveTally.unverified > liveTally.available + liveTally.unavailable,
  JSON.stringify(liveTally),
);
check(
  "readiness covers far less than the full catalog",
  live.size < toolNames.length / 4,
  `${live.size} reported for ${toolNames.length} tools`,
);

// ---- The Tools view ------------------------------------------------------
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
  const upstream = await realFetch(raw, init);
  const text = await upstream.text();
  return {
    ok: upstream.ok,
    status: upstream.status,
    headers: upstream.headers,
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
const until = async (predicate, timeout = 90_000) => {
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
await until(() => state.sessionReady);

// Readiness is published by the Setup view, which is where the user fixes it.
window.document.querySelector('.rail-link[data-view="setup"]')?.click();
const loaded = await until(() => state.operationReadiness.size > 0);
check(
  "the Setup view publishes operation readiness",
  loaded,
  `${state.operationReadiness.size} operations`,
);

const blockedNames = [...state.operationReadiness.entries()]
  .filter(([, entry]) => entry.available === false)
  .map(([name]) => name)
  .filter((name) => state.tools.some((tool) => tool.name === name));
check(
  "the host reports at least one blocked tool",
  blockedNames.length > 0,
  blockedNames.join(", "),
);

window.document.querySelector('.rail-link[data-view="tools"]')?.click();
await until(() => window.document.querySelectorAll(".tool-card").length > 0);

const cards = [...window.document.querySelectorAll(".tool-card")];
check(
  "every tool still renders, including blocked ones",
  cards.length === state.tools.length,
  `${cards.length} of ${state.tools.length}`,
);

const marked = cards.filter((card) => card.classList.contains("unavailable"));
check(
  "blocked tools are marked unavailable",
  marked.length === blockedNames.length,
  `${marked.length} marked, ${blockedNames.length} expected`,
);
check(
  "a marked card explains why",
  marked.every((card) => (card.getAttribute("title") ?? "").length > 0),
);

// The critical asymmetry: unverified tools must NOT be marked.
const unmarkedCount = cards.length - marked.length;
check(
  "unverified tools are not marked either way",
  unmarkedCount === state.tools.length - blockedNames.length,
  `${unmarkedCount} unmarked`,
);
// The threat is a *readiness* verdict painted on a tool REA never reported.
// Other badges legitimately say "ok" (the `readOnlyHint` annotation renders as
// "read-only"), so assert on readiness claims, not on colour alone.
const nameOf = (card) => card.getAttribute("data-tool") ?? "";
// Scope to badges and the title. `textContent` includes the tool description,
// and REA's prose legitimately contains words like "unavailable" ("Reports
// stale locators and unavailable bundles") — matching that flagged a
// read-only guidance tool as a readiness claim.
const claimsReadiness = (card) =>
  [...card.querySelectorAll(".badge")].some(
    (badge) => (badge.textContent ?? "").trim() === "unavailable",
  ) ||
  /^Not available on this host|Available via/iu.test(
    card.getAttribute("title") ?? "",
  );
check(
  "every card exposes its tool name",
  cards.every((card) => nameOf(card).length > 0),
  `${cards.filter((card) => nameOf(card).length === 0).length} without`,
);
const falselyCleared = cards.filter(
  (card) =>
    claimsReadiness(card) &&
    readinessFor(state.operationReadiness, nameOf(card)) === null,
);
check(
  "no card carries a readiness verdict REA did not give",
  falselyCleared.length === 0,
  falselyCleared.slice(0, 5).map(nameOf).join(", "),
);

// And the tally must state the unknown share rather than hiding it.
const note = window.document.getElementById("tools-readiness-note");
check("the Tools view states a readiness tally", note !== null);
const noteText = note?.textContent ?? "";
check(
  "the tally names the unverified count",
  /\d+ unverified/u.test(noteText),
  noteText.slice(0, 140),
);
check(
  "the tally names the blocked count",
  /\d+ unavailable on this host/u.test(noteText),
  "",
);

check("no runtime errors", errors.length === 0, errors.join(" | "));

await fetch(`${base}/api/sessions`, {
  method: "DELETE",
  headers,
}).catch(() => undefined);

if (failures.length > 0) {
  console.error(`\ntool-readiness: ${failures.length} failure(s).`);
  process.exit(1);
}
console.log("\ntool-readiness: all checks passed.");
