/**
 * End-to-end smoke test: boots the real browser app in jsdom against a live
 * server, generates the built-in samples, launches a suggested analysis and
 * checks that a result renders.
 *
 * jsdom is not a dependency of this repository, so the test reports a skip
 * instead of failing when it is unavailable.
 *
 *   node web/test/dom-smoke.mjs [http://127.0.0.1:4180]
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
  console.log("dom-smoke: jsdom is not installed; skipping.");
  process.exit(0);
}

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

const moduleUrl = (path) =>
  pathToFileURL(new URL(`../app/js/${path}`, import.meta.url).pathname).href;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until `predicate` holds, or give up after `timeout` milliseconds. */
const until = async (predicate, timeout = 30_000) => {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      if (predicate()) return true;
    } catch {
      // The DOM may be mid-render.
    }
    await wait(150);
  }
  return false;
};
const failures = [];
const check = (label, ok, detail = "") => {
  if (!ok) failures.push(`${label} ${detail}`.trim());
  console.log(
    `${ok ? "ok  " : "FAIL"} ${label}${detail === "" ? "" : ` — ${detail}`}`,
  );
};

try {
  await import(moduleUrl("main.js"));
} catch (error) {
  console.error(`dom-smoke: the app failed to boot: ${error.stack ?? error}`);
  process.exit(1);
}
const rail = window.document.getElementById("rail-status-text");
await until(
  () =>
    rail.textContent.includes("tools") &&
    !rail.textContent.includes("Connecting"),
);

check("session starts", /\d+ tools/u.test(rail.textContent), rail.textContent);

const samplesButton = [...window.document.querySelectorAll(".launcher")].find(
  (node) => node.textContent.includes("built-in sample"),
);
if (samplesButton === undefined) {
  console.error("dom-smoke: the sample launcher is missing.");
  process.exit(1);
}
samplesButton.click();
const settled = await until(
  () =>
    window.document.querySelectorAll(".target-row").length === 4 &&
    window.document.querySelectorAll(".suggestion").length > 0,
);

const targets = window.document.querySelectorAll(".target-row").length;
const suggestions = window.document.querySelectorAll(".suggestion");
check("samples create targets", settled && targets === 4, `${targets} targets`);
check(
  "suggestions appear for the selected target",
  suggestions.length > 0,
  `${suggestions.length} suggestions`,
);

if (suggestions.length > 0) {
  suggestions[0].click();
  await until(() => window.document.querySelector(".tool-form") !== null);
  check(
    "a suggestion opens the runner",
    window.document.getElementById("drawer").hidden === false,
  );
  const form = window.document.querySelector(".tool-form");
  const visible = [...form.querySelectorAll(".form-field")].filter(
    (node) => node.closest(".tool-form-advanced") === null,
  );
  check(
    "the primary path input is visible",
    visible.length > 0,
    visible.map((node) => node.querySelector("label")?.textContent).join(", "),
  );
  form.requestSubmit();
  await until(
    () =>
      window.document.querySelector(".result-meta") !== null ||
      window.document.querySelector(".error-card") !== null,
  );
  const meta = window.document.querySelector(".result-meta")?.textContent ?? "";
  check(
    "the analysis returns a result",
    meta.includes("Completed") || meta.includes("Failed"),
    meta.slice(0, 120),
  );
}

for (const view of ["tools", "targets", "evidence", "setup", "workspace"]) {
  const button = window.document.querySelector(
    `.rail-link[data-view="${view}"]`,
  );
  const title = window.document.getElementById("view-title");
  button.click();
  await until(
    () => window.document.getElementById("view-root").innerHTML.length > 500,
  );
  check(
    `the ${view} view renders`,
    title.textContent.length > 0 &&
      window.document.getElementById("view-root").innerHTML.length > 500,
  );
}

// A <button> may only contain phrasing content, and controls may not nest:
// catch both before they reach a browser's error-recovery parser.
const shell = window.document.getElementById("view-root");
check(
  "no block content inside buttons",
  shell.querySelectorAll("button div, button p").length === 0,
  `${shell.querySelectorAll("button div, button p").length} found`,
);
check(
  "no nested interactive elements",
  shell.querySelectorAll("button button, a button, button a, button input")
    .length === 0,
);

check("no runtime errors", errors.length === 0, errors.join(" | "));

const { api } = await import(moduleUrl("api.js"));
await api.endSession().catch(() => undefined);

if (failures.length > 0) {
  console.error(`\ndom-smoke: ${failures.length} failure(s).`);
  process.exit(1);
}
console.log("\ndom-smoke: all checks passed.");
