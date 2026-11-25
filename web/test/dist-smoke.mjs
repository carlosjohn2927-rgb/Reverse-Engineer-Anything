/**
 * Boots the production build — the minified single-file bundle and the
 * fingerprinted shell that ship in `web/dist` — and drives it end to end.
 *
 * jsdom does not execute `<script type="module">`, so the shipped bundle is
 * imported as a real ES module. That is what makes this test meaningful: it
 * exercises the exact bytes the build produced, including minification and
 * tree-shaking, rather than the readable source modules.
 *
 *   node web/test/dist-smoke.mjs http://127.0.0.1:4180 [path/to/dist]
 */
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const base = process.argv[2] ?? "http://127.0.0.1:4180";
const distRoot =
  process.argv[3] ?? new URL("../dist", import.meta.url).pathname;

let JSDOM;
try {
  const require = createRequire(import.meta.url);
  ({ JSDOM } = require("jsdom"));
} catch {
  // A silent skip would let a broken test suite look green. jsdom is optional
  // for the repository but required for this check, so say so and fail unless
  // the caller has explicitly accepted the skip.
  if (process.env.REA_WEB_ALLOW_SKIP === "1") {
    console.log(
      "dist-smoke: jsdom is not installed; skipping (REA_WEB_ALLOW_SKIP=1).",
    );
    process.exit(0);
  }
  console.error(
    "dist-smoke: jsdom is required for this check. Install it with `npm i -D jsdom` " +
      "or set REA_WEB_ALLOW_SKIP=1 to skip.",
  );
  process.exit(1);
}

if (!existsSync(join(distRoot, "index.html"))) {
  console.log(
    "dist-smoke: no build found; run `npm run build` first. Skipping.",
  );
  process.exit(0);
}

const assets = readdirSync(join(distRoot, "assets"));
const bundleName = assets.find((name) => /^app\.[0-9a-f]+\.js$/u.test(name));
const cssName = assets.find((name) => /^app\.[0-9a-f]+\.css$/u.test(name));
if (bundleName === undefined || cssName === undefined) {
  console.error("dist-smoke: the build is missing its bundle or stylesheet.");
  process.exit(1);
}

const failures = [];
const check = (label, ok, detail = "") => {
  if (!ok) failures.push(`${label} ${detail}`.trim());
  console.log(
    `${ok ? "ok  " : "FAIL"} ${label}${detail === "" ? "" : ` — ${detail}`}`,
  );
};

const shell = readFileSync(join(distRoot, "index.html"), "utf8");
check(
  "the shell references the fingerprinted bundle",
  shell.includes(`/assets/${bundleName}`),
);
check(
  "the shell references the fingerprinted stylesheet",
  shell.includes(`/assets/${cssName}`),
);
check(
  "the shell references no unbundled module",
  !shell.includes("/js/main.js") && !shell.includes("/styles/app.css"),
);

const bundle = readFileSync(join(distRoot, "assets", bundleName), "utf8");
// Minification collapses the module graph onto very long lines; the shipped
// bundle should average well over 500 characters per line.
const bundleLines = bundle.trimEnd().split("\n");
const averageLine = Math.round(bundle.trimEnd().length / bundleLines.length);
check("the bundle is minified", averageLine > 500, `${averageLine} chars/line`);
check(
  "the bundle keeps its source map link",
  bundle.includes(`//# sourceMappingURL=${bundleName}.map`),
);

const dom = new JSDOM(shell, {
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

const staging = mkdtempSync(join(tmpdir(), "rea-dist-"));
const moduleFile = join(staging, "bundle.mjs");
writeFileSync(moduleFile, bundle);
try {
  await import(pathToFileURL(moduleFile).href);
} catch (error) {
  const detail =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(`dist-smoke: the built bundle threw on import:\n${detail}`);
  process.exit(1);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (predicate, timeout = 30_000) => {
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

const rail = () =>
  window.document.getElementById("rail-status-text")?.textContent ?? "";
await until(() => /\d+ tools/u.test(rail()));
check("the built app reaches a session", /\d+ tools/u.test(rail()), rail());
check(
  "the built app renders its launchers",
  window.document.querySelectorAll(".launcher").length === 4,
);

[...window.document.querySelectorAll(".launcher")]
  .find((node) => node.textContent.includes("built-in sample"))
  ?.click();
await until(() => window.document.querySelectorAll(".suggestion").length > 0);
check(
  "the built app derives suggestions",
  window.document.querySelectorAll(".target-row").length === 4 &&
    window.document.querySelectorAll(".suggestion").length > 0,
  `${window.document.querySelectorAll(".target-row").length} targets, ${window.document.querySelectorAll(".suggestion").length} suggestions`,
);

window.document.querySelector(".suggestion")?.click();
await until(() => window.document.querySelector(".tool-form") !== null);
window.document.querySelector(".tool-form")?.requestSubmit();
await until(
  () =>
    window.document.querySelector(".result-meta") !== null ||
    window.document.querySelector(".error-card") !== null,
);
const meta = window.document.querySelector(".result-meta")?.textContent ?? "";
check(
  "the built app returns an analysis",
  meta.includes("Completed") || meta.includes("Failed"),
  meta.slice(0, 100),
);
check(
  "the built app raises no runtime errors",
  errors.length === 0,
  errors.join(" | "),
);

// The session the bundle opened is closed by the test runner when it shuts the
// server down; the runner also asserts that no child processes survive.

if (failures.length > 0) {
  console.error(`\ndist-smoke: ${failures.length} failure(s).`);
  process.exit(1);
}
console.log("\ndist-smoke: all checks passed.");
