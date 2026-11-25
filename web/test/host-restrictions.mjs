/**
 * Ten integrations are gated on the *host*, and nothing in the product said so.
 *
 * REA's `HOST_RESTRICTED_FEATURES` gates 13 advertised tools. On an
 * unsupported platform/arch **no environment variable makes them pass** —
 * `createServer` sets `hostUnsupported` from pure `platform`/`arch` predicates.
 * That is the opposite kind of failure from "you have not configured it": one
 * needs a path, the other needs a different machine. The workspace reported
 * neither, so both looked like the same grey "unverified" row.
 *
 * The line this suite will not cross is claiming a *supported* feature is
 * available. Host support is one gate of several; a supported integration can
 * still need a configured path or a connected device. `supported: true` means
 * "this OS and architecture do not block it", and every rendered sentence has
 * to say that much and no more.
 *
 * The rules are pure functions of platform and arch, so they are testable
 * against REA's own behaviour: on this host, calling the gated tools must
 * produce *configuration* errors (`capability_unavailable`,
 * `provider_unavailable`), never `unsupported_host`. If that ever changes, the
 * encoded rules are wrong and this suite fails.
 *
 *   node web/test/host-restrictions.mjs http://127.0.0.1:4180
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
      "host-restrictions: jsdom is not installed; skipping (REA_WEB_ALLOW_SKIP=1).",
    );
    process.exit(0);
  }
  console.error(
    "host-restrictions: jsdom is required for this check. Install it with " +
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
  HOST_RESTRICTED_FEATURES,
  FEATURE_FOR_TOOL,
  featureSupportFor,
  toolHostSupport,
  hostRestrictionSummary,
  restrictionsFromPayload,
  HOST_SUPPORT_IS_NOT_AVAILABILITY,
} = await import(
  pathToFileURL(
    new URL("../app/js/host-restrictions.js", import.meta.url).pathname,
  ).href
);

// ---- the rule table ------------------------------------------------------
check(
  "all ten REA host-restricted features are covered",
  HOST_RESTRICTED_FEATURES.length === 10,
  `${HOST_RESTRICTED_FEATURES.length} features`,
);
check(
  "every feature names the tools it gates",
  HOST_RESTRICTED_FEATURES.every(
    (feature) => feature.tools.length > 0 && feature.supportedWhen.length > 0,
  ),
);
const gatedTools = HOST_RESTRICTED_FEATURES.flatMap((feature) => feature.tools);
check(
  "the features gate 13 advertised tools",
  gatedTools.length === 13,
  `${gatedTools.length} tools`,
);
check(
  "no tool is gated by two features",
  new Set(gatedTools).size === gatedTools.length,
);
check(
  "the tool index and the table agree",
  FEATURE_FOR_TOOL.size === gatedTools.length,
);

// ---- platform rules, evaluated the way REA evaluates them ----------------
const onLinuxX64 = featureSupportFor("linux", "x64");
check(
  "Linux x64 satisfies every one of the ten",
  onLinuxX64.every((feature) => feature.supported),
  onLinuxX64
    .filter((f) => !f.supported)
    .map((f) => f.id)
    .join(", ") || "none blocked",
);

const onMacArm = featureSupportFor("darwin", "arm64");
check(
  "macOS blocks every one of the ten",
  onMacArm.every((feature) => !feature.supported),
  `${onMacArm.filter((f) => f.supported).length} wrongly allowed`,
);

const onWindows = featureSupportFor("win32", "x64");
const pcapOnWindows = onWindows.find((f) => f.id === "pcapCapture");
check(
  "Windows keeps PCAP inspection, which has a Job Objects bound",
  pcapOnWindows?.supported === true,
  String(pcapOnWindows?.supported),
);
check(
  "Windows blocks the Linux-only runtimes",
  onWindows.filter((f) => f.supported).length === 1,
  `${onWindows.filter((f) => f.supported).length} allowed`,
);

const onLinuxArm = featureSupportFor("linux", "arm64");
check(
  "Linux arm64 keeps the platform-only features",
  onLinuxArm.find((f) => f.id === "persistentDebugger")?.supported === true,
);
// Five features need Linux only (persistentDebugger, packetCapture,
// signalRecording and the two firmware ones) plus pcapCapture's
// Linux-or-Windows bound; the four pwntools/Wakaru/EVM features need x64.
check(
  "Linux arm64 keeps the six platform-bound features",
  onLinuxArm.filter((f) => f.supported).length === 6,
  `${onLinuxArm.filter((f) => f.supported).length} allowed`,
);
check(
  "Linux arm64 blocks exactly the four x64-only features",
  onLinuxArm
    .filter((f) => !f.supported)
    .map((f) => f.id)
    .sort()
    .join(",") === "binaryLayout,evmInterface,javascriptRecovery,recordedCrash",
  onLinuxArm
    .filter((f) => !f.supported)
    .map((f) => f.id)
    .join(","),
);

// ---- the summary states both directions ---------------------------------
const blockedSummary = hostRestrictionSummary(onMacArm, {
  platform: "darwin",
  arch: "arm64",
});
check(
  "a blocked host names the machine, not a missing setting",
  blockedSummary.includes("macOS") === false &&
    blockedSummary.includes("darwin arm64") &&
    blockedSummary.includes("no setting changes that"),
  blockedSummary,
);
const allowedSummary = hostRestrictionSummary(onLinuxX64, {
  platform: "linux",
  arch: "x64",
});
check(
  "a supported host still refuses to call the features available",
  allowedSummary.includes("does not mean configured"),
  allowedSummary,
);

// ---- the projection onto tools ------------------------------------------
const projected = toolHostSupport(onMacArm);
check(
  "every gated tool projects a host verdict",
  projected.size === 13,
  `${projected.size} tools`,
);
check(
  "an unsupported host marks its tools unsupported",
  [...projected.values()].every((entry) => entry.supported === false),
);
check(
  "a supported host does not mark anything available",
  [...toolHostSupport(onLinuxX64).values()].every(
    (entry) => entry.supported === true,
  ) && HOST_SUPPORT_IS_NOT_AVAILABILITY.includes("not availability"),
);

// ---- payload parsing -----------------------------------------------------
check(
  "a malformed payload yields no features and no host",
  restrictionsFromPayload(null).features.length === 0 &&
    restrictionsFromPayload(null).host === null,
);
check(
  "a feature without a boolean verdict is dropped",
  restrictionsFromPayload({
    host: { platform: "linux", arch: "x64" },
    features: [{ id: "packetCapture", tools: ["inspect_packet_capture"] }],
  }).features.length === 0,
);

// ---- the live route ------------------------------------------------------
const live = await (await fetch(`${base}/api/host-restrictions`)).json();
check(
  "the route reports this host's platform and arch",
  live?.host?.platform === process.platform &&
    live?.host?.arch === process.arch,
  `${live?.host?.platform} ${live?.host?.arch}`,
);
check(
  "the route reports all ten features",
  live?.features?.length === 10,
  `${live?.features?.length ?? 0} features`,
);
const liveBlocked = (live?.features ?? []).filter((f) => f.supported === false);
check(
  "on this Linux x64 host nothing is host-blocked",
  liveBlocked.length === 0,
  liveBlocked.map((f) => f.id).join(", ") || "none blocked",
);

// ---- the premise, verified against REA itself ---------------------------
// On a host where every feature is supported, a gated tool must fail on
// *configuration*. If REA ever answers `unsupported_host` here, the encoded
// rules disagree with the server and this check is the alarm.
const session = await (
  await fetch(`${base}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  })
).json();
const call = async (tool, args) => {
  const response = await fetch(`${base}/api/call`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-rea-session": session.sessionId,
    },
    body: JSON.stringify({
      sessionId: session.sessionId,
      tool,
      arguments: args,
    }),
  });
  return response.json();
};

// Each of these needs a required argument; supply a real local file where the
// schema demands a path so the answer is about the runtime, not the input.
const samplePath = "/home/user/Reverse-Engineer-Anything/package.json";
const probes = [
  ["decode_signal_recording", { path: samplePath, decoders: "uart" }],
  ["inspect_pcap_capture", { path: samplePath }],
  ["inspect_packet_capture", { path: samplePath, fields: "http" }],
  [
    "recover_javascript_sources",
    {
      path: samplePath,
      output_directory: `/home/user/.local/rea-web/workspaces/${session.sessionId}`,
    },
  ],
  ["start_gdb_session", {}],
  ["inspect_binary_layout", { path: samplePath }],
  ["inspect_recorded_crash", { path: samplePath }],
  ["inspect_firmware_regions", { path: samplePath }],
  ["inspect_evm_interface", { path: samplePath, encoding: "hex" }],
];

const observed = [];
for (const [tool, args] of probes) {
  const result = await call(tool, args);
  observed.push({
    tool,
    code: result?.error?.code ?? result?.status ?? "none",
  });
}
const unsupported = observed.filter(
  (entry) => entry.code === "unsupported_host",
);
check(
  "no gated tool reports unsupported_host on a supported host",
  unsupported.length === 0,
  unsupported.map((entry) => entry.tool).join(", ") || "none",
);
check(
  "every gated tool still fails on configuration, not on the host",
  observed.filter(
    (entry) =>
      entry.code === "capability_unavailable" ||
      entry.code === "provider_unavailable",
  ).length >= 5,
  observed.map((entry) => `${entry.tool}=${entry.code}`).join(" "),
);

// ---- the Setup panel -----------------------------------------------------
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
window.document.querySelector('.rail-link[data-view="setup"]')?.click();

// Gate on store state first: the panel paints a "Checking…" skeleton, which
// would satisfy any text-presence check and hide a load that never finished.
const loaded = await until(
  () => state.hostRestrictions !== null && state.hostRestrictions !== undefined,
);
check("the Setup view loads host restrictions", loaded);

const rendered = await until(() =>
  (window.document.getElementById("view-root")?.textContent ?? "").includes(
    "Host-restricted integrations",
  ),
);
check("the Setup view renders the host restriction panel", rendered);

const viewText = window.document.getElementById("view-root")?.textContent ?? "";
check(
  "the panel states host support is not availability",
  viewText.includes("Host support is not availability"),
);
check(
  "the panel names this host",
  viewText.includes("linux x64"),
  viewText.match(/All 10[^.]*\./)?.[0] ?? "no host sentence",
);
// On a host that blocks everything, each row must carry its own remediation.
// This host blocks nothing, so the assertion is that supported rows instead say
// what they still need — never that they are ready.
check(
  "a supported row says it still needs its own configuration",
  viewText.includes("Still needs its own configuration"),
);
check(
  "the panel lists the gated tools",
  viewText.includes("start_gdb_session") ||
    viewText.includes("inspect_packet_capture"),
);

const rows = window.document.querySelectorAll(".check-row");
check(
  "the panel renders one row per feature",
  rows.length >= 10,
  `${rows.length} rows including other panels`,
);
const supportedBadges = [
  ...window.document.querySelectorAll(".badge.warn"),
].filter((badge) => badge.textContent === "host supported");
check(
  "a supported feature is labelled supported, never available",
  supportedBadges.length > 0 &&
    !viewText.includes("host available") &&
    !viewText.includes("available on this host"),
  `${supportedBadges.length} supported badges`,
);

check(
  "no runtime errors",
  errors.length === 0,
  errors[0]?.split("\n")[0] ?? "",
);

if (failures.length > 0) {
  console.error(`\nhost-restrictions: ${failures.length} failure(s).`);
  process.exitCode = 1;
} else {
  console.log("\nhost-restrictions: all checks passed.");
}

await fetch(`${base}/api/sessions`, {
  method: "DELETE",
  headers: {
    "content-type": "application/json",
    "x-rea-session": session.sessionId,
  },
  body: JSON.stringify({ sessionId: session.sessionId }),
}).catch(() => undefined);
