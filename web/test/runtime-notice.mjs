/**
 * The workspace must tell the user when the runtime behind REA is too old for
 * part of the tool set, instead of letting the first sign be a failed analysis.
 *
 * This asserts the two halves of that promise against whatever runtime the
 * server is currently using: the notice appears with a working install action
 * when the runtime is old, and is absent when it is current.
 *
 *   node web/test/runtime-notice.mjs http://127.0.0.1:4180
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
      "runtime-notice: jsdom is not installed; skipping (REA_WEB_ALLOW_SKIP=1).",
    );
    process.exit(0);
  }
  console.error(
    "runtime-notice: jsdom is required for this check. Install it with `npm i -D jsdom` " +
      "or set REA_WEB_ALLOW_SKIP=1 to skip.",
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

const status = await (await fetch(`${base}/api/status`)).json();
const major = Number(
  String(status.runtime?.nodeVersion ?? "")
    .replace(/^v/u, "")
    .split(".")[0],
);
const shell = readFileSync(
  new URL("../app/index.html", import.meta.url),
  "utf8",
);
const dom = new JSDOM(shell, {
  url: `${base}/`,
  pretendToBeVisual: true,
  runScripts: "outside-only",
});
const { window } = dom;

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

const moduleUrl = (path) =>
  pathToFileURL(new URL(`../app/js/${path}`, import.meta.url).pathname).href;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (predicate, timeout = 25_000) => {
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
await until(() =>
  /\d+ tools/u.test(
    window.document.getElementById("rail-status-text")?.textContent ?? "",
  ),
);

const notice = window.document.querySelector(".notice.warn");
if (major >= 24) {
  check(
    "no runtime notice on a supported runtime",
    notice === null,
    `node ${major}`,
  );
} else {
  check(
    "a runtime notice appears on an old runtime",
    notice !== null,
    `node ${major}`,
  );
  check(
    "the notice offers the install action",
    [...(notice?.querySelectorAll("button") ?? [])].some((button) =>
      button.textContent.includes("Install Node.js 24"),
    ),
  );
  check(
    "the notice explains the consequence",
    (notice?.textContent ?? "").includes("Node.js 24"),
  );
}

const { api } = await import(moduleUrl("api.js"));
await api.endSession().catch(() => undefined);

if (failures.length > 0) {
  console.error(`\nruntime-notice: ${failures.length} failure(s).`);
  process.exit(1);
}
console.log("\nruntime-notice: all checks passed.");
