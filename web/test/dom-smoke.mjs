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
  if (process.env.REA_WEB_ALLOW_SKIP === "1") {
    console.log(
      "dom-smoke: jsdom is not installed; skipping (REA_WEB_ALLOW_SKIP=1).",
    );
    process.exit(0);
  }
  console.error(
    "dom-smoke: jsdom is required for this check. Install it with `npm i -D jsdom` " +
      "or set REA_WEB_ALLOW_SKIP=1 to skip.",
  );
  process.exit(1);
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
  const detail =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(`dom-smoke: the app failed to boot: ${detail}`);
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
await until(() =>
  [...window.document.querySelectorAll(".activity-row")].some((row) =>
    row.textContent.toLowerCase().includes("inspect-managed-artifact"),
  ),
);
check(
  "the built-in sample launcher runs a real sample analysis",
  [...window.document.querySelectorAll(".activity-row")].some((row) =>
    row.textContent.toLowerCase().includes("inspect-managed-artifact"),
  ),
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

check(
  "the workspace has an obvious Analyse selected target action",
  [...window.document.querySelectorAll(".hero-actions button")].some((button) =>
    button.textContent.includes("Analyse selected target"),
  ),
);
const folderLauncher = [...window.document.querySelectorAll(".launcher")].find(
  (node) => node.textContent.includes("Inspect a local folder"),
);
folderLauncher?.click();
await until(
  () =>
    window.document.getElementById("view-title").textContent === "Targets" &&
    window.document.getElementById("local-folder-input") !== null,
);
check(
  "the local-folder launcher opens a device folder picker",
  window.document.getElementById("view-title").textContent === "Targets" &&
    window.document.querySelector("#local-folder-input[webkitdirectory]") !==
      null &&
    [...window.document.querySelectorAll("#view-root button")].some((button) =>
      button.textContent.includes("Choose folder & analyse"),
    ),
);
window.document.querySelector('.rail-link[data-view="workspace"]').click();
await until(() => window.document.querySelector(".launcher") !== null);

window.document.querySelector('.rail-link[data-view="evidence"]').click();
const evidenceSearch = window.document.querySelector(
  '.view-stack input[type="search"]',
);
evidenceSearch.focus();
evidenceSearch.value = "inspect";
evidenceSearch.dispatchEvent(new window.Event("input", { bubbles: true }));
const focusedAfterFilter = window.document.activeElement === evidenceSearch;
evidenceSearch.value = "inspect-no-match";
evidenceSearch.dispatchEvent(new window.Event("input", { bubbles: true }));
check(
  "the Evidence search preserves focus while filtering",
  focusedAfterFilter &&
    window.document.activeElement === evidenceSearch &&
    window.document.querySelector(".evidence-list .empty-state h3")
      ?.textContent === "No matches",
);
window.document.querySelector('.rail-link[data-view="workspace"]').click();
await until(() => window.document.querySelector(".launcher") !== null);

const websiteLauncher = [...window.document.querySelectorAll(".launcher")].find(
  (node) => node.textContent.includes("Inspect a website"),
);
websiteLauncher?.click();
await until(
  () => window.document.getElementById("view-title").textContent === "Targets",
);
check(
  "the website launcher opens the website workflow",
  window.document.getElementById("view-title").textContent === "Targets" &&
    window.document.getElementById("website-url") !== null &&
    window.document.getElementById("website-cdp-endpoint") !== null,
);
check(
  "the website form explains that the page must already be open",
  window.document
    .querySelector(".website-intro")
    ?.textContent.includes("does not open the site itself") === true,
);

const { api: testApi } = await import(moduleUrl("api.js"));
const realCallTool = testApi.callTool;
const realWriteText = testApi.writeText;
const savedCrawlFiles = [];
testApi.writeText = async (name, text) => {
  savedCrawlFiles.push({ name, text });
  return { name, path: `/session/${name}`, bytes: Buffer.byteLength(text) };
};
let fakeCurrentUrl = "https://example.test/account";
const crawlerNavigations = [];
const mapFetchRequests = [];
testApi.callTool = async (tool, args, options) => {
  if (tool === "list_browser_targets")
    return {
      tool,
      status: "ok",
      durationMs: 12,
      payload: {
        evidence_id: "ev_website_targets_smoke",
        subject: { name: "Browser page targets" },
        normalized_result: {
          targets: [
            {
              target_id: "target-1",
              type: "page",
              title: "Example site",
              url: fakeCurrentUrl,
              origin: "https://example.test",
              attached: false,
            },
          ],
        },
      },
    };
  if (tool === "capture_browser_scenario") {
    fakeCurrentUrl = args.start_url.url;
    crawlerNavigations.push(fakeCurrentUrl);
    return { tool, status: "ok", durationMs: 20, payload: {} };
  }
  if (tool === "inspect_web_page")
    return {
      tool,
      status: "ok",
      durationMs: 10,
      payload: {
        normalized_result: {
          target: { url: fakeCurrentUrl },
          scripts: {
            items: [
              {
                script_key: "scr_" + "a".repeat(64),
                url: `${fakeCurrentUrl}/assets/app.js`,
                source: {
                  included: true,
                  artifact: {
                    text: "console.log('captured');",
                    bytes: 24,
                    sha256: "a".repeat(64),
                  },
                },
              },
            ],
          },
          safe_metadata: {
            dom_urls:
              fakeCurrentUrl === "https://example.test/account"
                ? [
                    {
                      attribute: "href",
                      url: "https://example.test/about",
                      destination_scope: "approved",
                    },
                    {
                      attribute: "href",
                      url: "https://outside.test/",
                      destination_scope: "outside_policy",
                    },
                  ]
                : [
                    {
                      attribute: "href",
                      url: "https://example.test/account",
                      destination_scope: "approved",
                    },
                  ],
          },
        },
      },
    };
  if (tool === "analyze_web_bundle") {
    mapFetchRequests.push(args.fetch_source_maps);
    return {
      tool,
      status: "ok",
      durationMs: 30,
      payload: {
        evidence_id: `ev_${fakeCurrentUrl.split("/").at(-1)}`,
        normalized_result: {
          capture: {
            target_url: fakeCurrentUrl,
            scripts_observed: 2,
            scripts_analyzed: 2,
          },
          source_maps: {
            status: "included",
            requested: 1,
            processed: 1,
            items: [
              {
                status: "included",
                script_key: "scr_" + "a".repeat(64),
                declared_url: `${fakeCurrentUrl}/assets/app.js.map`,
                effective_url: `${fakeCurrentUrl}/assets/app.js.map`,
                artifact: {
                  text: '{"version":3,"sources":[]}',
                  bytes: 24,
                  sha256: "b".repeat(64),
                },
              },
            ],
          },
        },
      },
    };
  }
  return realCallTool(tool, args, options);
};
window.document.getElementById("website-url").value =
  "https://example.test/account";
window.document.querySelector(".website-form").requestSubmit();
await until(() => window.document.querySelector(".website-page") !== null);
check(
  "the website flow finds matching open tabs",
  window.document
    .querySelector(".website-page")
    ?.textContent.includes("Example site") === true,
);
window.document.querySelector(".website-page").click();
window.document.querySelector(".website-actions .ghost-button").click();
await until(() =>
  window.document
    .getElementById("drawer-title")
    .textContent.toLowerCase()
    .includes("analyze web bundle"),
);
check(
  "website analysis preselects the connected page",
  window.document.querySelector('input[name="target_id"]')?.value ===
    "target-1",
  [...window.document.querySelectorAll(".tool-form input")]
    .map((input) => `${input.name}=${input.value}`)
    .join(", "),
);
window.document.getElementById("drawer-close").click();
check(
  "captured-code saving is opt-in by default",
  window.document.getElementById("website-save-captured").checked === false &&
    window.document.getElementById("website-fetch-source-maps").checked ===
      false,
);
window.document.getElementById("website-save-captured").checked = true;
window.document.getElementById("website-fetch-source-maps").checked = true;
window.document
  .querySelector(".website-crawl-controls .primary-button")
  .click();
await until(
  () =>
    window.document
      .querySelector(".website-crawl-controls .website-message")
      ?.textContent.includes("Finished") === true,
);
check(
  "the website crawl analyzes linked same-origin pages",
  window.document.querySelectorAll(
    ".website-crawl-row:not(.website-crawl-head)",
  ).length === 2,
);
check(
  "the website crawl navigates internally and excludes external links",
  crawlerNavigations.length === 1 &&
    crawlerNavigations[0] === "https://example.test/about" &&
    !window.document
      .querySelector(".website-crawl-report")
      ?.textContent.includes("outside.test"),
);
check(
  "the crawl saves client-side scripts and fetched source maps",
  savedCrawlFiles.some((file) => file.name.endsWith(".js")) &&
    savedCrawlFiles.some((file) => file.name.endsWith(".map.json")) &&
    savedCrawlFiles.some((file) => file.name.endsWith("-manifest.json")),
  savedCrawlFiles.map((file) => file.name).join(", "),
);
check(
  "source-map fetching is controlled by the optional checkbox",
  mapFetchRequests.length === 2 && mapFetchRequests.every(Boolean),
);
check(
  "the export outcome reports its session workspace files",
  window.document
    .querySelector(".website-crawl-export")
    ?.textContent.includes("session workspace") === true,
);
check(
  "each saved crawl file has a direct download action",
  window.document.querySelectorAll(".website-export-download").length ===
    savedCrawlFiles.length,
);
testApi.callTool = realCallTool;
testApi.writeText = realWriteText;

window.document.querySelector('.rail-link[data-view="workspace"]').click();
const addTargetButton = [
  ...window.document.querySelectorAll(".hero-actions button"),
].find((button) => button.textContent.includes("Add a target"));
addTargetButton?.click();
await until(
  () => window.document.getElementById("view-title").textContent === "Targets",
);
check(
  "the dashboard Add a target button opens Targets",
  window.document.getElementById("view-title").textContent === "Targets" &&
    window.document.querySelector(
      'input[placeholder="/absolute/path/to/app-or-binary"]',
    ) !== null,
);

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
