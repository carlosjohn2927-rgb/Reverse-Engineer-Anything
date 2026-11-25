/**
 * REA installs its own documentation, and nothing in the workspace could read it.
 *
 * `search_guidance` and `read_guidance_section` were listed under a "guidance"
 * family and reachable only by knowing the tool name and the opaque locator
 * format. The prompts in the Workflows view are a different, much narrower
 * surface: six fixed workflows with arguments, not the ~40 sections in the
 * installed bundle.
 *
 * The property this suite exists to protect is a sentence REA writes itself:
 *
 *   "No bundled guidance sections matched this query. This does not indicate
 *    whether an analysis capability is available."
 *
 * A failed search is a statement about documentation, never about capability.
 * The UI must not turn "I have no notes on this" into "this is impossible", and
 * it must not present a documentation section as an observation about the
 * user's target. Both are pinned below, along with the locator rule: a locator
 * is valid only for the bundle that minted it.
 *
 *   node web/test/guidance-search.mjs http://127.0.0.1:4180
 */
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
      "guidance-search: jsdom is not installed; skipping (REA_WEB_ALLOW_SKIP=1).",
    );
    process.exit(0);
  }
  console.error(
    "guidance-search: jsdom is required for this check. Install it with " +
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

const {
  guidanceFromSearch,
  guidanceFromSection,
  guidanceSummary,
  validateQuery,
  NO_MATCH_IS_NOT_A_VERDICT,
} = await import(
  pathToFileURL(new URL("../app/js/guidance.js", import.meta.url).pathname).href
);

// ---- live contract -------------------------------------------------------
const session = await (
  await fetch(`${base}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  })
).json();
const sessionId = session.sessionId;

const call = async (tool, args) => {
  const response = await fetch(`${base}/api/call`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-rea-session": sessionId },
    body: JSON.stringify({ sessionId, tool, arguments: args }),
  });
  const body = await response.json();
  return { response, body, payload: body?.payload?.result ?? body?.payload };
};

const hit = await call("search_guidance", { query: "frida", limit: 5 });
check(
  "REA answers a guidance search",
  hit.body?.status === "ok" && hit.payload?.status === "matches",
  hit.payload?.status ?? hit.body?.status,
);
check(
  "the guidance search needs no open target",
  hit.payload?.source === "installed_rea_guidance",
  hit.payload?.source,
);
check(
  "every match carries a locator and a matched term",
  Array.isArray(hit.payload?.matches) &&
    hit.payload.matches.length > 0 &&
    hit.payload.matches.every(
      (match) => typeof match.locator === "string" && match.locator.length > 0,
    ),
  `${hit.payload?.matches?.length ?? 0} matches`,
);

const search = guidanceFromSearch(hit.payload);
check(
  "the projection keeps REA's match count",
  search.status === "matches" && search.matches.length > 0,
  `${search.total} matched`,
);
check(
  "the projection keeps the bundle identity",
  typeof search.bundleSha256 === "string" &&
    /^[a-f0-9]{64}$/u.test(search.bundleSha256),
  String(search.bundleSha256).slice(0, 12),
);
check(
  "the summary says guidance is documentation, not a finding",
  guidanceSummary(search).includes("not a finding"),
  guidanceSummary(search).slice(0, 70),
);

// The locator round trip.
const first = search.matches[0];
const section = await call("read_guidance_section", { locator: first.locator });
check(
  "a locator from a match opens its section",
  section.body?.status === "ok" && section.payload?.status === "section",
  section.payload?.status ?? section.body?.status,
);
const opened = guidanceFromSection(section.payload);
check(
  "the opened section carries its guide and body",
  opened.guide !== null && opened.content.length > 0,
  `${opened.guide} · ${opened.content.length} chars`,
);
check("a valid section is not flagged stale", opened.stale === false);

// A locator is bundle-anchored: a token from another bundle must not open.
const forged = await call("read_guidance_section", {
  locator: "rea-guide-v1.eyJ2IjoxLCJidW5kbGUiOiJkZWFkYmVlZiJ9",
});
check(
  "a locator from a different bundle is refused",
  forged.body?.status === "error" || forged.payload?.status !== "section",
  forged.body?.error?.code ?? forged.payload?.status ?? "accepted",
);

// ---- the no-match sentence ----------------------------------------------
const miss = await call("search_guidance", {
  query: "qqzzxx no such guidance term",
  limit: 3,
});
const empty = guidanceFromSearch(miss.payload);
check(
  "a search with no matches is reported as no_matches",
  empty.status === "no_matches",
  empty.status,
);
check(
  "REA's own no-match message is preserved verbatim",
  typeof miss.payload?.message === "string" &&
    miss.payload.message.includes(
      "does not indicate whether an analysis capability is available",
    ),
  (miss.payload?.message ?? "").slice(0, 60),
);
check(
  "the summary repeats that a miss is not a capability verdict",
  guidanceSummary(empty).includes(NO_MATCH_IS_NOT_A_VERDICT),
  guidanceSummary(empty).slice(0, 80),
);
check(
  "a miss never renders a match row",
  empty.matches.length === 0 && empty.total === 0,
);

// ---- malformed payloads -------------------------------------------------
check(
  "a null payload yields no status and no matches",
  guidanceFromSearch(null).status === "unknown" &&
    guidanceFromSearch(null).matches.length === 0,
);
check(
  "a status of matches with no usable rows is not a success",
  guidanceFromSearch({ status: "matches", matches: [] }).status ===
    "no_matches",
);
check(
  "a row without a locator cannot be opened and is dropped",
  guidanceFromSearch({
    status: "matches",
    matches: [{ guide: "a.md", heading: "H" }],
  }).matches.length === 0,
);
check(
  "a section with an unexpected status is flagged stale",
  guidanceFromSection({ status: "stale_locator", content: "" }).stale === true,
);

// ---- query validation ---------------------------------------------------
check(
  "an empty query is refused before the round trip",
  validateQuery("   ").ok === false,
);
check(
  "an over-long query names the limit",
  validateQuery("x".repeat(2049)).ok === false &&
    String(validateQuery("x".repeat(2049)).message).includes("2048"),
);
check(
  "a normal query is accepted",
  validateQuery("evidence bundle").ok === true,
);

// ---- the Workflows view -------------------------------------------------
const { readFileSync } = await import("node:fs");
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
window.document.querySelector('.rail-link[data-view="workflows"]')?.click();

const rendered = await until(() =>
  (window.document.getElementById("view-root")?.textContent ?? "").includes(
    "Guidance search",
  ),
);
check("the Workflows view offers guidance search", rendered);

const viewText = window.document.getElementById("view-root")?.textContent ?? "";
check(
  "the view states a miss is not a capability verdict",
  viewText.includes("nothing about whether a capability exists"),
);
check(
  "the guidance panel is separate from the six prompts",
  viewText.includes("guided workflows advertised by REA"),
);

// Drive the real search: the assertion is on what the user sees.
const input = /** @type {HTMLInputElement} */ (
  window.document.querySelector(".guidance-input")
);
check("the panel has a search input", input !== null && input !== undefined);
input.value = "frida";
const searchButton = [...window.document.querySelectorAll("button")].find(
  (button) => button.textContent?.trim() === "Search",
);
searchButton?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

// Wait for a settled result, not the "Searching…" paint.
const settled = await until(() => {
  const text =
    window.document.querySelector(".guidance-results")?.textContent ?? "";
  return (
    text.length > 0 &&
    !text.includes("Searching REA") &&
    (text.includes("matched in") || text.includes("did not answer"))
  );
});
check("clicking search reports a result", settled);

const rows = window.document.querySelectorAll(".guidance-match");
check(
  "matches render as openable rows",
  rows.length > 0,
  `${rows.length} row(s)`,
);
check(
  "each row names the guide it came from",
  [...rows].every((row) => (row.textContent ?? "").includes(".md")),
);

// Open the first row: the reader is the whole point of the locator.
rows[0]?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
const openedView = await until(() => {
  const text =
    window.document.querySelector(".guidance-reader")?.textContent ?? "";
  return text.length > 0 && !text.includes("Opening section");
});
check("clicking a match opens its section", openedView);

const readerText =
  window.document.querySelector(".guidance-reader")?.textContent ?? "";
check(
  "the opened section is labelled as documentation",
  readerText.includes("not what was found in your target"),
  readerText.slice(0, 80),
);
check(
  "the section body is rendered in full",
  (window.document.querySelector(".guidance-reader pre")?.textContent ?? "")
    .length > 100,
);

// A miss must say nothing about capability, on screen.
const missInput = /** @type {HTMLInputElement} */ (
  window.document.querySelector(".guidance-input")
);
missInput.value = "qqzzxx no such guidance term";
[...window.document.querySelectorAll("button")]
  .find((button) => button.textContent?.trim() === "Search")
  ?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

const missSettled = await until(() =>
  (
    window.document.querySelector(".guidance-results")?.textContent ?? ""
  ).includes("No section"),
);
check("a miss renders its own statement", missSettled);
const missText =
  window.document.querySelector(".guidance-results")?.textContent ?? "";
check(
  "the miss states it is not a capability verdict",
  missText.includes(
    "does not indicate whether an analysis capability is available",
  ) || missText.includes("nothing about whether a capability exists"),
  missText.slice(0, 90),
);
check(
  "a miss does not leave a stale match row on screen",
  window.document.querySelectorAll(".guidance-match").length === 0,
);

check(
  "no runtime errors",
  errors.length === 0,
  errors[0]?.split("\n")[0] ?? "",
);

if (failures.length > 0) {
  console.error(`\nguidance-search: ${failures.length} failure(s).`);
  process.exitCode = 1;
} else {
  console.log("\nguidance-search: all checks passed.");
}

await fetch(`${base}/api/sessions`, {
  method: "DELETE",
  headers: { "content-type": "application/json", "x-rea-session": sessionId },
  body: JSON.stringify({ sessionId }),
}).catch(() => undefined);
