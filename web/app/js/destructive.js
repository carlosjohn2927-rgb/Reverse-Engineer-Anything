/**
 * What a destructive tool actually touches.
 *
 * 32 advertised tools carry `destructiveHint: true`. The drawer told all 32 the
 * same sentence: "Edits analysis state. Original artifact bytes are not
 * modified." That is true of the eleven provider-state editors and false of the
 * rest. Read against REA's own descriptions:
 *
 *   uninstall_adb_package  "package removal ... without data retention"
 *   push_adb_file          "Push one local file to an absolute device path"
 *   export_evidence_bundle "Atomically write ... to the requested local path"
 *   capture_process_scenario "Run one caller-selected command under a PTY"
 *
 * Telling someone their artifact bytes are safe before they remove a package
 * from a phone is the kind of reassurance that gets acted on. The badge was not
 * wrong about the *bytes* — it was answering a question the user had not asked
 * while ignoring four they had.
 *
 * What replaces it is not a second guess at MCP. `destructiveHint` is all the
 * protocol carries: no effect list reaches the client (REA computes
 * `launch_process`, `may_write_filesystem` and friends internally, but the MCP
 * tool listing exposes only the four boolean hints). So this module classifies
 * by what REA's own description states, and every category quotes that
 * description rather than paraphrasing it. A tool that fits no category is
 * reported as unclassified rather than assumed harmless — the failure mode to
 * avoid is a reassuring label, not a missing one.
 */

/**
 * @typedef {"analysis-state" | "device" | "filesystem" | "process" | "session"} Surface
 */

/**
 * The surfaces a destructive tool can change, ordered by how hard the change is
 * to undo. Device first: it is the only one that can destroy something that is
 * not on this machine and has no copy here.
 *
 * @type {ReadonlyArray<{ id: Surface, label: string, consequence: string, undo: string }>}
 */
export const DESTRUCTIVE_SURFACES = [
  {
    id: "device",
    label: "Changes the device",
    consequence:
      "This acts on a connected device. Data on it can be removed or replaced, and this workspace holds no copy.",
    undo: "Cannot be undone from here. Take a device backup first if the state matters.",
  },
  {
    id: "filesystem",
    label: "Writes to the filesystem",
    consequence:
      "This writes a file on the analysis host. An existing file at that path can be replaced.",
    undo: "Point it at a path you can afford to overwrite, or export somewhere disposable.",
  },
  {
    id: "process",
    label: "Runs or ends a process",
    consequence:
      "This starts or stops a real process. Commands run in a live debugger or console can do far more than edit analysis state.",
    undo: "There is no undo. Whatever the command does has already happened.",
  },
  {
    id: "session",
    label: "Ends an analysis session",
    consequence:
      "This closes a live session. Unsaved analysis state in that session is released, and a detached target can keep running unwatched.",
    undo: "Re-open the target; earlier Evidence records are retained.",
  },
  {
    id: "analysis-state",
    label: "Edits analysis state",
    consequence:
      "This changes names, comments or bookmarks in the analysis document. The original artifact bytes are not modified.",
    undo: "Undo is provider-specific; clearing a comment or bookmark reverses it.",
  },
];

/** Fast lookup from surface id to its description. */
const SURFACE = new Map(DESTRUCTIVE_SURFACES.map((entry) => [entry.id, entry]));

/**
 * Per-tool classification, with the phrase from REA's description that decides
 * it. Grouped by the shared sentence so a reader can check the reasoning.
 *
 * @type {ReadonlyArray<{ tools: readonly string[], surfaces: readonly Surface[], because: string }>}
 */
const CLASSIFICATION = [
  // REA: "A device-mutating tool: install success does not establish prior
  // package state" / "package removal ... without data retention".
  {
    tools: [
      "install_adb_package",
      "uninstall_adb_package",
      "push_adb_file",
      "start_adb_app",
      "start_adb_activity",
      "stop_adb_app",
    ],
    surfaces: ["device"],
    because:
      'REA calls each of these "a device-mutating tool"; uninstallation is documented as running "without data retention".',
  },
  // REA: "Atomically write ... to the requested local path".
  {
    tools: ["export_evidence_bundle"],
    surfaces: ["filesystem"],
    because: 'REA documents it as writing to "the requested local path".',
  },
  // REA: "optionally write a provider-neutral analysis snapshot atomically".
  {
    tools: ["close_binary"],
    surfaces: ["session", "filesystem"],
    because:
      "REA documents it as optionally writing a snapshot to a caller-supplied path before closing the session.",
  },
  // REA: "Run one caller-selected command under a PTY".
  {
    tools: ["capture_process_scenario"],
    surfaces: ["process"],
    because: 'REA documents it as running "one caller-selected command".',
  },
  // REA: "Run one arbitrary Rizin command" / "one unrestricted GDB CLI command"
  // / "one unrestricted command in a persistent Rizin debugger session".
  {
    tools: [
      "execute_rizin_command",
      "cutter_command",
      "gdb_console",
      "rizin_debug_command",
    ],
    surfaces: ["process"],
    because:
      "REA documents these as arbitrary or unrestricted commands, which can execute plugin-provided effects.",
  },
  // REA: "Scripts can read or change target memory and behavior".
  {
    tools: ["load_frida_script", "instrument_with_frida"],
    surfaces: ["process"],
    because:
      'REA documents that scripts "can read or change target memory and behavior".',
  },
  // REA: "Run selected-element press ... in one exact native app window".
  {
    tools: [
      "capture_native_ui_scenario",
      "capture_browser_scenario",
      "capture_electron_scenario",
    ],
    surfaces: ["process"],
    because:
      "REA documents these as starting an application and performing actions in it.",
  },
  // REA: "Launch the active Mach-O as an owned process under LLDB".
  {
    tools: ["observe_native_calls"],
    surfaces: ["process"],
    because: "REA documents it as launching the target as an owned process.",
  },
  // REA: "Instrument one selected CDP page ... until stopped".
  {
    tools: ["observe_web_execution"],
    surfaces: ["process"],
    because:
      "REA documents it as instrumenting a live page and holding it in unoptimised execution.",
  },
  // REA: "Resume the process created by a paused Frida spawn session".
  {
    tools: ["resume_frida_session"],
    surfaces: ["process"],
    because: "REA documents it as resuming a paused process.",
  },
  // REA: "Close the owned GDB process" / "attempt to detach" / "verify no
  // inferior remains". Teardown, but it can leave a target running.
  {
    tools: [
      "close_gdb_session",
      "close_frida_session",
      "close_rizin_debug_session",
      "start_rizin_debug_session",
    ],
    surfaces: ["session"],
    because:
      "REA documents these as closing or starting owned debugger sessions, and a detached target may keep running.",
  },
  // REA: "This mutates the Hopper document" / "Ghidra changes its ephemeral
  // session analysis database only".
  {
    tools: [
      "annotate_native_function",
      "set_address_name",
      "set_addresses_names",
      "set_bookmark",
      "set_comment",
      "set_inline_comment",
      "unset_bookmark",
    ],
    surfaces: ["analysis-state"],
    because:
      "REA documents these as editing the analysis document, and explicitly that they do not alter binary bytes.",
  },
];

/**
 * @typedef {object} DestructiveProfile
 * @property {readonly Surface[]} surfaces ordered most-consequential first
 * @property {boolean} unclassified true when REA's description decided nothing
 * @property {string} because the phrase the classification rests on
 * @property {{ id: Surface, label: string, consequence: string, undo: string }[]} details
 * @property {string} headline one sentence naming the surfaces
 * @property {boolean} artifactBytesSafe true only when no surface can touch bytes
 */

/**
 * Describe what running one tool can change.
 *
 * A destructive tool this module has no entry for is `unclassified` and says
 * so. That is deliberate: silently returning "analysis state only" would
 * recreate the defect this replaces.
 *
 * @param {{ name: string, annotations?: { destructiveHint?: boolean } | null }} tool
 * @returns {DestructiveProfile | null} null when the tool is not destructive
 */
export const destructiveProfile = (tool) => {
  if (tool?.annotations?.destructiveHint !== true) return null;
  const entry = CLASSIFICATION.find((group) => group.tools.includes(tool.name));
  if (entry === undefined)
    /** @type {DestructiveProfile} */
    return {
      surfaces: [],
      unclassified: true,
      because:
        "REA marked this tool destructive, and this workspace has no reading of what it changes. Treat it as able to change anything it can reach.",
      details: [],
      headline:
        "REA marks this tool destructive, and its exact effects are not described here",
      artifactBytesSafe: false,
    };

  const details = entry.surfaces.map((surface) => {
    const detail = SURFACE.get(surface);
    if (detail === undefined)
      throw new Error(`Unknown destructive surface: ${surface}`);
    return detail;
  });
  /** @type {DestructiveProfile} */
  const profile = {
    surfaces: entry.surfaces,
    unclassified: false,
    because: entry.because,
    details,
    headline: details.map((detail) => detail.label).join(" · "),
    // Only a pure analysis-state edit may claim the artifact is untouched, and
    // even then the claim is REA's.
    artifactBytesSafe:
      entry.surfaces.length === 1 && entry.surfaces[0] === "analysis-state",
  };
  return profile;
};

/**
 * The line above the destructive tools in the Tools view. Names the split so a
 * count of "32 destructive" does not read as "32 identical".
 *
 * @param {number} total destructive tools advertised
 * @param {number} unclassified how many have no reading here
 */
export const destructiveSummary = (total, unclassified) => {
  const device =
    CLASSIFICATION.find((group) => group.surfaces.includes("device"))?.tools
      .length ?? 0;
  const base = `${total} tools are marked destructive by REA. They do not all do the same thing: ${device} change a connected device, others write files, run processes or edit analysis state.`;
  return unclassified === 0
    ? base
    : `${base} ${unclassified} of them are not described here — assume they can change anything they can reach.`;
};

/**
 * Every tool this module knows about, for the coverage test.
 *
 * @returns {string[]}
 */
export const classifiedTools = () =>
  CLASSIFICATION.flatMap((group) => [...group.tools]);
