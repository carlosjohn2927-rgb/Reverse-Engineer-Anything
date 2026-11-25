/**
 * A closed overlay must actually be closed.
 *
 * The drawer, its scrim and the optional-fields panel are hidden with the
 * `hidden` attribute, but every one of them also carries an author `display`
 * rule (`.drawer { display: flex }`, `.tool-form-advanced { display: grid }`).
 * The UA stylesheet's `[hidden] { display: none }` loses that cascade, so
 * `hidden = true` left the runner on screen with its close button, scrim and
 * Escape all apparently broken.
 *
 * This suite drives the real app: it opens the runner, closes it three ways
 * (button, scrim, Escape) and checks the drawer is both marked hidden *and*
 * computed as display:none, so a future stylesheet change cannot quietly
 * resurrect the bug. It also checks the evidence detail panel is revealed when
 * its row opens.
 *
 *   node web/test/drawer-dismiss.mjs http://127.0.0.1:4180
 */
import { readFileSync, readdirSync } from "node:fs";
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
      "drawer-dismiss: jsdom is not installed; skipping (REA_WEB_ALLOW_SKIP=1).",
    );
    process.exit(0);
  }
  console.error(
    "drawer-dismiss: jsdom is required for this check. Install it with " +
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

// Test the stylesheet users actually receive: the fingerprinted build, where
// lightningcss has minified and possibly rewritten the rule. Fall back to the
// concatenated source only when no build exists (`--no-build` runs).
const sourceCss = ["app.css", "tools.css"]
  .map((name) =>
    readFileSync(new URL(`../app/styles/${name}`, import.meta.url), "utf8"),
  )
  .join("\n");

const distAssets = new URL("../dist/assets/", import.meta.url);
let css = sourceCss;
let cssOrigin = "source";
let builtCssName;
try {
  builtCssName = readdirSync(distAssets).find((name) =>
    /^app\.[0-9a-f]+\.css$/u.test(name),
  );
  if (builtCssName !== undefined) {
    css = readFileSync(new URL(builtCssName, distAssets), "utf8");
    cssOrigin = `dist/assets/${builtCssName}`;
  }
} catch {
  // No build yet; the source stylesheets describe the same cascade order.
}
console.log(`drawer-dismiss: testing the ${cssOrigin} stylesheet.`);

// A stale build must not pass: the shipped sheet has to carry the rule too.
check(
  "the shipped stylesheet enforces [hidden]",
  /\[hidden\][^{]*\{[^}]*display:\s*none\s*!important/u.test(
    builtCssName === undefined ? sourceCss : css,
  ),
  builtCssName === undefined ? "checked source (no build)" : builtCssName,
);

const html = readFileSync(
  new URL("../app/index.html", import.meta.url),
  "utf8",
).replace("</head>", `<style>${css}</style></head>`);

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
const until = async (predicate, timeout = 30_000) => {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      if (predicate()) return true;
    } catch {
      // Mid-render.
    }
    await wait(150);
  }
  return false;
};

// Boot the whole app so the drawer's close affordances are wired exactly as
// they are in production (`initDrawer` is called from `main.js`).
try {
  await import(moduleUrl("main.js"));
} catch (error) {
  const detail =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(`drawer-dismiss: the app failed to boot: ${detail}`);
  process.exit(1);
}

const { h } = await import(moduleUrl("dom.js"));
const { launchTool } = await import(moduleUrl("runner.js"));
const { state } = await import(moduleUrl("store.js"));

const drawer = window.document.getElementById("drawer");
const scrim = window.document.getElementById("drawer-scrim");
const computed = (node) => window.getComputedStyle(node).display;

// The catalog arrives with the session; wait for it before launching a tool.
const catalogReady = await until(() => state.tools.length > 0, 60_000);
check("the session catalog loads", catalogReady, `${state.tools.length} tools`);

/** An overlay is closed only when it is hidden *and* out of the layout. */
const closed = (node) => node.hidden === true && computed(node) === "none";
const open = (node) => node.hidden === false && computed(node) !== "none";

check(
  "the drawer starts closed and out of the layout",
  closed(drawer),
  `hidden=${drawer.hidden} display=${computed(drawer)}`,
);
check(
  "the scrim starts closed and out of the layout",
  closed(scrim),
  `hidden=${scrim.hidden} display=${computed(scrim)}`,
);

// Open the runner through its public entry point. `launchTool` resolves when
// the drawer closes, so it is deliberately not awaited.
const toolName =
  state.tools.find((tool) => tool.name === "binary_summary")?.name ??
  state.tools.find((tool) => tool.hostDependent !== true)?.name;
check("a launchable tool exists", toolName !== undefined, String(toolName));
const launched = launchTool(toolName, {}).catch(() => undefined);
check(
  "the runner opens",
  await until(() => drawer.hidden === false),
  `hidden=${drawer.hidden}`,
);
check(
  "an open drawer is laid out",
  open(drawer) && open(scrim),
  `drawer display=${computed(drawer)} scrim display=${computed(scrim)}`,
);

const optional = window.document.querySelector(".tool-form-advanced");
if (optional !== null) {
  check(
    "collapsed optional fields stay out of the layout",
    closed(optional),
    `hidden=${optional.hidden} display=${computed(optional)}`,
  );
  const toggle = [...window.document.querySelectorAll("button")].find((node) =>
    node.textContent.startsWith("Show "),
  );
  if (toggle !== undefined) {
    toggle.click();
    check(
      "revealed optional fields lay out",
      open(optional),
      `hidden=${optional.hidden} display=${computed(optional)}`,
    );
    toggle.click();
  }
}

// 1. The close button.
window.document.getElementById("drawer-close").click();
check(
  "the close button closes the drawer",
  closed(drawer) && closed(scrim),
  `drawer display=${computed(drawer)} scrim display=${computed(scrim)}`,
);
await wait(50);

// 2. A click on the scrim.
if (drawer.hidden) {
  drawer.hidden = false;
  scrim.hidden = false;
}
scrim.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check(
  "the scrim click closes the drawer",
  closed(drawer) && closed(scrim),
  `drawer display=${computed(drawer)} scrim display=${computed(scrim)}`,
);
await wait(50);

// 3. The Escape key.
drawer.hidden = false;
scrim.hidden = false;
window.document.dispatchEvent(
  new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
);
check(
  "Escape closes the drawer",
  closed(drawer) && closed(scrim),
  `drawer display=${computed(drawer)} scrim display=${computed(scrim)}`,
);
await wait(50);

// A close during a run must not leave the body scroll-locked.
check(
  "closing restores page scrolling",
  window.document.body.style.overflow === "",
  `body overflow=${JSON.stringify(window.document.body.style.overflow)}`,
);

await launched;

// The evidence row reveals its payload when it opens, and hides it again.
state.evidence = [];
state.evidence.push({
  id: "test-evidence",
  at: Date.now(),
  tool: "binary_summary",
  status: "ok",
  durationMs: 1,
  payload: {
    evidence_id: "ev_test",
    subject: { name: "drawer-dismiss" },
    normalized_result: { note: "payload" },
  },
});
const { renderEvidence } = await import(moduleUrl("views/evidence.js"));
const root = window.document.getElementById("view-root");
renderEvidence(root);

const row = root.querySelector("details.evidence-row");
check("the evidence row renders", row !== null);
if (row !== null) {
  const panel = row.querySelector(".evidence-detail");
  check(
    "a collapsed evidence panel stays out of the layout",
    closed(panel),
    `hidden=${panel.hidden} display=${computed(panel)}`,
  );
  row.open = true;
  check(
    "opening an evidence row reveals the payload",
    await until(() => panel.hidden === false),
    `hidden=${panel.hidden}`,
  );
  check(
    "the revealed evidence panel lays out",
    open(panel) && panel.childElementCount > 0,
    `display=${computed(panel)} children=${panel.childElementCount}`,
  );
  row.open = false;
  check(
    "closing an evidence row hides the payload again",
    await until(() => panel.hidden === true),
    `hidden=${panel.hidden}`,
  );
}

check("no runtime errors", errors.length === 0, errors.join(" | "));

// A stray element can be unhidden by hand; the guard is what makes the
// stylesheet honour it, so assert the rule itself is present and winning.
const probe = h("div", { class: "drawer", hidden: true });
window.document.body.append(probe);
check(
  "the stylesheet forces [hidden] elements out of the layout",
  computed(probe) === "none",
  `display=${computed(probe)}`,
);
probe.remove();

const { api } = await import(moduleUrl("api.js"));
await api.endSession().catch(() => undefined);

if (failures.length > 0) {
  console.error(`\ndrawer-dismiss: ${failures.length} failure(s).`);
  process.exit(1);
}
console.log("\ndrawer-dismiss: all checks passed.");
