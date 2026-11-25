/**
 * Projecting `rea capabilities` onto individual tool names.
 *
 * REA reports availability per *operation group*, and only for the providers it
 * can inspect without a live target. That produces three very different states,
 * and conflating them is what makes a readiness badge lie:
 *
 *   unavailable — REA says this operation cannot run on this host, with a
 *                 machine-readable code such as `unsupported_host`. Definite.
 *   available   — REA says the group can run with the installed tooling.
 *                 Definite, but conditional on the runtime state it did not
 *                 see (an open document, a device on the bus).
 *   unverified  — REA reported nothing about this tool. **This is the common
 *                 case: 214 of 233 tools.** It does not mean broken, and it
 *                 does not mean fine. The UI must not guess either way.
 *
 * `capabilities` is a CLI command, not an MCP tool (it answers -32602 over
 * MCP), so it is read out-of-band and always with no target open. Consequences
 * that shape this module:
 *
 *   - decompiler-backed tooling is *never* reported, because those providers
 *     are only listed as candidates, not operation groups;
 *   - the `hostDependent` tools (adb, frida, gdb, rizin, jeb, cutter) are never
 *     reported either;
 *   - a "cannot run" verdict is trustworthy, a "can run" verdict is a floor.
 */

/** @typedef {{ available: boolean, code: string | null, provider: string, reason: string | null }} Readiness */

/**
 * Flatten a `rea capabilities` payload into one entry per operation.
 *
 * @param {any} payload
 * @returns {Map<string, Readiness>}
 */
export const readinessFromCapabilities = (payload) => {
  /** @type {Map<string, Readiness>} */
  const readiness = new Map();
  for (const entry of payload?.capabilities ?? []) {
    const provider = entry?.provider?.id ?? "unknown";
    for (const group of entry?.groups ?? []) {
      for (const operation of group?.operations ?? []) {
        // A tool served by several providers is unavailable only if every
        // group that serves it is unavailable; a single working path is enough.
        const existing = readiness.get(operation);
        const candidate = {
          available: group.available === true,
          code: group.availability_code ?? null,
          provider,
          reason: group.reason ?? null,
        };
        if (
          existing === undefined ||
          (!existing.available && candidate.available)
        )
          readiness.set(operation, candidate);
      }
    }
  }
  return readiness;
};

/**
 * Readiness for one tool, or `null` when REA said nothing about it.
 *
 * @param {Map<string, Readiness>} readiness
 * @param {string} toolName
 * @returns {Readiness | null}
 */
export const readinessFor = (readiness, toolName) =>
  readiness.get(toolName) ?? null;

/**
 * One-line human summary for a readiness verdict.
 *
 * @param {Readiness} readiness
 */
export const readinessSummary = (readiness) => {
  if (readiness.available)
    return `Available via ${readiness.provider}. Runtime state (an open target, a connected device) can still block it.`;
  const code = readiness.code === null ? "" : ` (${readiness.code})`;
  const reason = readiness.reason === null ? "" : ` ${readiness.reason}`;
  return `Not available on this host${code}.${reason}`.trim();
};

/**
 * Counts used for the Tools view banner, so the scale of "unknown" stays
 * visible instead of reading as "everything is fine".
 *
 * @param {readonly string[]} toolNames
 * @param {Map<string, Readiness>} readiness
 */
export const readinessTally = (toolNames, readiness) => {
  let available = 0;
  let unavailable = 0;
  for (const name of toolNames) {
    const entry = readiness.get(name);
    if (entry === undefined) continue;
    if (entry.available) available += 1;
    else unavailable += 1;
  }
  return {
    available,
    unavailable,
    unverified: toolNames.length - available - unavailable,
    total: toolNames.length,
  };
};
