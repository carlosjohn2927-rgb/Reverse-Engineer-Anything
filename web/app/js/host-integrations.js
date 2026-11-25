/**
 * Configuration presence for the host integrations REA never inspects.
 *
 * 51 tools depend on an external runtime — adb (24), frida (8), gdb (4), rizin
 * (4), jeb (4), cutter (2) — and 26 more depend on tshark, apktool, binwalk,
 * frida's Python bindings and the rest. Verified against live data: **none of
 * them appear in `rea capabilities` or `rea doctor`**, so the workspace had
 * nothing to say about them at all.
 *
 * The honest ceiling here is that *presence is not function*:
 *
 *   configured      — a binary resolves, or a URL is set. Says nothing about
 *                     whether a device is plugged in, a Cutter bridge is
 *                     listening, or the binary works.
 *   not configured  — nothing resolves. This one is trustworthy, because
 *                     REA's own remediation is exactly "set this / install it".
 *   not verified    — nothing was checked, or the check itself failed.
 *
 * That is why this is a separate axis from `readiness.js` and must never be
 * folded into "available". A green tick here would claim adb works, which we
 * cannot know without running it against a device.
 */

/** @typedef {"configured" | "not_configured" | "not_verified"} ConfigState */

/**
 * @typedef {{
 *   id: string,
 *   label: string,
 *   tools: number,
 *   env: readonly string[],
 *   binary: string | null,
 *   remediation: string,
 * }} HostIntegration
 */

/**
 * The host integrations, with the tool count each one gates and the setting
 * REA documents for it. `binary` is the executable REA falls back to on PATH
 * when the env var is unset — only set where REA really does that.
 *
 * @type {readonly HostIntegration[]}
 */
export const HOST_INTEGRATIONS = Object.freeze([
  {
    id: "adb",
    label: "Android Debug Bridge",
    tools: 24,
    env: ["REA_ADB_PATH"],
    binary: "adb",
    remediation:
      "Set REA_ADB_PATH to an absolute adb executable, or make adb available on PATH. A device or emulator must also be attached.",
  },
  {
    id: "frida",
    label: "Frida",
    tools: 8,
    env: ["REA_FRIDA_PYTHON", "REA_PWNTOOLS_PYTHON"],
    binary: null,
    remediation:
      "Install Frida's Python bindings where REA can reach them. Frida also needs a device or process to attach to.",
  },
  {
    id: "gdb",
    label: "GDB",
    tools: 4,
    env: ["REA_GDB_COMMAND"],
    binary: "gdb",
    remediation:
      "Set REA_GDB_COMMAND to an installed executable GDB command, or make gdb available on PATH.",
  },
  {
    id: "rizin",
    label: "Rizin debugger",
    tools: 4,
    env: ["REA_RIZIN_COMMAND"],
    binary: "rizin",
    remediation:
      "Set REA_RIZIN_COMMAND to an installed executable rizin command, or make rizin available on PATH.",
  },
  {
    id: "jeb",
    label: "JEB",
    tools: 4,
    env: ["REA_JEB_MCP_URL"],
    binary: null,
    remediation:
      "Start a JEB client serving MCP and point REA_JEB_MCP_URL at it (default http://127.0.0.1:8425/mcp). REA does not install or launch JEB.",
  },
  {
    id: "cutter",
    label: "Cutter",
    tools: 2,
    env: ["REA_CUTTER_BRIDGE_DIR"],
    binary: null,
    remediation:
      "Set REA_CUTTER_BRIDGE_DIR to a running Cutter bridge directory.",
  },
  {
    id: "tshark",
    label: "tshark packet capture",
    tools: 4,
    env: ["REA_TSHARK_COMMAND"],
    binary: "tshark",
    remediation:
      "Set REA_TSHARK_COMMAND to an installed tshark, or make tshark available on PATH.",
  },
  {
    id: "apktool",
    label: "Apktool",
    tools: 2,
    env: ["REA_APKTOOL_COMMAND"],
    binary: "apktool",
    remediation:
      "Set REA_APKTOOL_COMMAND to Apktool 2.7.0 or newer, or make apktool available on PATH.",
  },
  {
    id: "binwalk",
    label: "binwalk firmware extraction",
    tools: 2,
    env: ["REA_BINWALK_COMMAND"],
    binary: "binwalk",
    remediation:
      "Set REA_BINWALK_COMMAND to an installed binwalk, or make binwalk available on PATH.",
  },
  {
    id: "objdump",
    label: "GNU objdump",
    tools: 1,
    env: ["REA_OBJDUMP_COMMAND"],
    binary: "objdump",
    remediation:
      "Set REA_OBJDUMP_COMMAND to an installed objdump, or make objdump available on PATH.",
  },
]);

/**
 * Classify one integration from what the server could observe.
 *
 * @param {HostIntegration} integration
 * @param {{ env: Record<string, string | null | undefined>, onPath: readonly string[] }} observed
 * @returns {{ state: ConfigState, via: string | null }}
 */
export const classifyIntegration = (integration, observed) => {
  for (const name of integration.env) {
    const value = observed.env[name];
    if (typeof value === "string" && value.trim().length > 0)
      return { state: "configured", via: `${name}=${value.trim()}` };
  }
  if (
    integration.binary !== null &&
    observed.onPath.includes(integration.binary)
  )
    return { state: "configured", via: `PATH:${integration.binary}` };
  return { state: "not_configured", via: null };
};

/**
 * One-line caveat that must travel with every "configured" verdict.
 */
export const CONFIGURED_IS_NOT_VERIFIED =
  "Configured means REA can find the runtime. It does not mean the runtime works: a device, bridge or session may still be missing.";
