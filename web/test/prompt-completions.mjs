/**
 * Prompt arguments that expect session-owned values must actually get them.
 *
 * REA turns on MCP `completions` and fills 14 of its 25 guided-workflow
 * arguments from the live session. `prompts/list` does not say which arguments
 * those are — it returns only a name, description and required flag — so
 * `web/app/js/completions.js` mirrors `src/contracts/promptContracts.ts`.
 *
 * A hand-written mirror rots. This suite pins it to the live server: every
 * argument the UI treats as completable must be accepted by
 * `completion/complete`, and every argument REA answers with values must be
 * one the UI asks about. If REA adds, renames or drops a completion argument,
 * this fails instead of the UI quietly turning a picker back into a text box.
 *
 *   node web/test/prompt-completions.mjs http://127.0.0.1:4180
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const base = process.argv[2] ?? "http://127.0.0.1:4180";

const failures = [];
const check = (label, ok, detail = "") => {
  if (!ok) failures.push(`${label} ${detail}`.trim());
  console.log(
    `${ok ? "ok  " : "FAIL"} ${label}${detail === "" ? "" : ` — ${detail}`}`,
  );
};

const {
  COMPLETION_KINDS,
  PROMPT_COMPLETIONS,
  completionKindFor,
  completionArgumentKeys,
} = await import(
  pathToFileURL(new URL("../app/js/completions.js", import.meta.url).pathname)
    .href
);

// ---- The map is internally consistent ------------------------------------
const keys = completionArgumentKeys();
check(
  "the completion map has no duplicate argument",
  keys.length === new Set(keys).size,
  `${keys.length} entries`,
);

const usedKinds = new Set(
  Object.values(PROMPT_COMPLETIONS).flatMap((args) => Object.values(args)),
);
const unknownKinds = [...usedKinds].filter(
  (kind) => !COMPLETION_KINDS.includes(kind),
);
check(
  "every mapped kind is a kind REA defines",
  unknownKinds.length === 0,
  unknownKinds.length === 0
    ? `${usedKinds.size} of ${COMPLETION_KINDS.length} kinds used`
    : `unknown: ${unknownKinds.join(", ")}`,
);

// ---- The map matches what REA advertises ---------------------------------
/** @type {any} */
let advertised = null;
try {
  advertised = JSON.parse(
    readFileSync(
      new URL("../../dist/mcp-catalog.json", import.meta.url),
      "utf8",
    ),
  );
} catch {
  console.log(
    "prompt-completions: dist/mcp-catalog.json is missing; checking the live server only.",
  );
}

if (advertised !== null) {
  const prompts = new Map(
    (advertised.prompts ?? []).map((prompt) => [prompt.name, prompt]),
  );

  const stalePrompts = Object.keys(PROMPT_COMPLETIONS).filter(
    (name) => !prompts.has(name),
  );
  check(
    "the map names no prompt REA does not advertise",
    stalePrompts.length === 0,
    stalePrompts.join(", "),
  );

  // REA's contract marks these with a `completion` field in `parameters`.
  const declared = new Set();
  for (const [name, prompt] of prompts)
    for (const [argument, parameter] of Object.entries(prompt.parameters ?? {}))
      if (parameter?.completion !== undefined)
        declared.add(`${name}/${argument}`);

  const missing = [...declared].filter((key) => !keys.includes(key));
  check(
    "every argument REA completes is mapped",
    missing.length === 0,
    missing.length === 0
      ? `${declared.size} declared arguments mapped`
      : `unmapped: ${missing.join(", ")}`,
  );

  const extra = keys.filter((key) => !declared.has(key));
  check(
    "the map invents no extra argument",
    extra.length === 0,
    extra.join(", "),
  );

  // The kind has to match the contract, not just the argument name.
  const wrongKind = [];
  for (const [name, prompt] of prompts)
    for (const [argument, parameter] of Object.entries(prompt.parameters ?? {}))
      if (parameter?.completion !== undefined) {
        const mapped = completionKindFor(name, argument);
        if (mapped !== parameter.completion)
          wrongKind.push(
            `${name}/${argument}: ${mapped} != ${parameter.completion}`,
          );
      }
  check(
    "each argument maps to the kind REA declares",
    wrongKind.length === 0,
    wrongKind.join("; "),
  );

  // Every prompt argument is either completable or deliberately free text.
  let promptArgs = 0;
  for (const prompt of prompts.values())
    promptArgs += (prompt.arguments ?? []).length;
  check(
    "the map covers the completable share of prompt arguments",
    declared.size < promptArgs && declared.size > 0,
    `${declared.size} of ${promptArgs} arguments`,
  );
}

// ---- The live server answers for every mapped argument -------------------
const session = await fetch(`${base}/api/sessions`, { method: "POST" }).then(
  (response) => response.json(),
);
check(
  "a session starts",
  typeof session.sessionId === "string",
  `${session.tools?.length ?? 0} tools, ${session.prompts?.length ?? 0} prompts`,
);

const headers = {
  "content-type": "application/json",
  "x-rea-session": session.sessionId,
};

/** @type {string[]} */
const rejected = [];
/** @type {string[]} */
const answeredWithValues = [];
for (const key of keys) {
  const [prompt, argument] = key.split("/");
  const response = await fetch(`${base}/api/complete`, {
    method: "POST",
    headers,
    body: JSON.stringify({ prompt, argument, value: "" }),
  });
  const payload = await response.json().catch(() => ({}));
  if (response.status !== 200 || !Array.isArray(payload.values))
    rejected.push(`${key} (${response.status})`);
  else if (payload.values.length > 0)
    answeredWithValues.push(`${key}=${payload.values.length}`);
}

check(
  "the server answers every mapped argument",
  rejected.length === 0,
  rejected.length === 0 ? `${keys.length} arguments` : rejected.join(", "),
);
check(
  "at least one argument resolves real values",
  answeredWithValues.length > 0,
  answeredWithValues.join(", "),
);

// `provider` is the one kind that does not depend on analysis, so it must
// always have values — that is what makes the rest of this test meaningful.
const provider = await fetch(`${base}/api/complete`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    prompt: "investigate_feature",
    argument: "provider_id",
    value: "",
  }),
}).then((response) => response.json());
check(
  "provider completion returns the installed providers",
  Array.isArray(provider.values) &&
    provider.values.includes("auto") &&
    provider.values.length > 1,
  (provider.values ?? []).join(", "),
);

// An argument with no session values yet must not be reported as an error.
const emptyCase = await fetch(`${base}/api/complete`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    prompt: "investigate_feature",
    argument: "document",
    value: "",
  }),
}).then(async (response) => ({
  status: response.status,
  json: await response.json(),
}));
check(
  "an empty completion list is not an error",
  emptyCase.status === 200 && Array.isArray(emptyCase.json.values),
  `${emptyCase.status}, ${emptyCase.json.values?.length ?? "?"} values`,
);

// Bad input is rejected rather than silently returning nothing.
const noPrompt = await fetch(`${base}/api/complete`, {
  method: "POST",
  headers,
  body: JSON.stringify({ argument: "document" }),
});
check(
  "a missing prompt is rejected",
  noPrompt.status === 400,
  String(noPrompt.status),
);
const noArgument = await fetch(`${base}/api/complete`, {
  method: "POST",
  headers,
  body: JSON.stringify({ prompt: "investigate_feature" }),
});
check(
  "a missing argument is rejected",
  noArgument.status === 400,
  String(noArgument.status),
);

// An unknown prompt must degrade to free text, never a hard failure.
const unknown = await fetch(`${base}/api/complete`, {
  method: "POST",
  headers,
  body: JSON.stringify({ prompt: "not_a_prompt", argument: "x", value: "" }),
}).then(async (response) => ({
  status: response.status,
  json: await response.json(),
}));
check(
  "an unknown prompt degrades to an empty list",
  unknown.status === 200 && Array.isArray(unknown.json.values),
  `${unknown.status}${unknown.json.unavailable ? " (reported)" : ""}`,
);

await fetch(`${base}/api/sessions`, {
  method: "DELETE",
  headers,
}).catch(() => undefined);

if (failures.length > 0) {
  console.error(`\nprompt-completions: ${failures.length} failure(s).`);
  process.exit(1);
}
console.log("\nprompt-completions: all checks passed.");
