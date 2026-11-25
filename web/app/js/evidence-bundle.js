/**
 * Evidence bundle transfer: what the web app can and cannot do.
 *
 * REA's bundle tools (`export_evidence_bundle`, `import_evidence_bundle`,
 * `get_evidence_bundle`, `compare_bundles`) all take absolute local filesystem
 * paths. A browser has no such path and no way to read one back, so every one
 * of those tools is unusable from the web app unaided. The server bridges the
 * gap by picking a path inside the session workspace — the browser never
 * supplies one — and these helpers describe the result.
 *
 * The module deliberately never writes a bundle itself. REA's manifests are
 * byte-stable and digest-anchored; a client that re-serialised them would
 * produce a file REA rejects, which is exactly the bug this replaces.
 */

/** Shown next to the transfer controls so the constraint is stated, not hidden. */
export const BUNDLE_TRANSFER_NOTE =
  "REA reads and writes bundles by absolute path, so the server stores them in the session workspace and streams the bytes here. Export downloads the exact file REA wrote; import is validated by REA before anything merges.";

/**
 * Describe one transfer outcome for display.
 *
 * The asymmetry that matters: an accepted export says REA produced a bundle,
 * never that the bundle is complete evidence. An empty bundle is valid and is
 * reported as a fact about the session, not as a failure, and a rejection is
 * REA's verdict about the file — never softened into a success.
 *
 * @param {{
 *   accepted: boolean,
 *   receipt?: { records: number, unknowns: number, bytes: number, empty: boolean, summary: string } | null,
 *   rejection?: { code: string, message: string | null, remediation: string | null } | null,
 *   name?: string,
 *   bytes?: number,
 *   sha256?: string,
 *   staged?: { name: string, bytes: number, sha256: string } | null,
 *   result?: unknown,
 * }} outcome
 * @returns {{ ok: boolean, title: string, body: string, detail: string | null }}
 */
export const describeTransfer = (outcome) => {
  if (!outcome.accepted) {
    const rejection = outcome.rejection ?? null;
    return {
      ok: false,
      title: "REA rejected this bundle",
      body:
        "Nothing was merged: REA validates the whole file before importing any of it. " +
        "A bundle has to be one REA itself exported; a hand-edited or re-serialised file fails on its digests.",
      detail: [rejection?.code ?? null, rejection?.message ?? null]
        .filter((part) => part !== null && part !== "")
        .join(" · "),
    };
  }

  // Import path: accepted, with the staged file REA actually read.
  if (outcome.receipt === undefined || outcome.receipt === null) {
    const staged = outcome.staged ?? null;
    const counts = readCounts(outcome.result);
    return {
      ok: true,
      title: "REA imported the bundle",
      body:
        counts === null
          ? `The records in ${staged?.name ?? "the bundle"} are now part of this session. Imported content is data: REA never executes it.`
          : `The records in ${staged?.name ?? "the bundle"} are now part of this session — ${counts}. Imported content is data: REA never executes it.`,
      detail:
        staged === null
          ? null
          : `${staged.name} · ${staged.bytes} B · sha256 ${staged.sha256.slice(0, 16)}…`,
    };
  }

  const receipt = outcome.receipt;
  return {
    ok: true,
    title: receipt.empty
      ? "REA wrote a valid, empty bundle"
      : "REA wrote the bundle",
    body: receipt.summary,
    detail:
      outcome.name === undefined
        ? null
        : `${outcome.name} · sha256 ${(outcome.sha256 ?? "").slice(0, 16)}…`,
  };
};

/**
 * REA reports import counts in its own shape; read them without assuming it.
 *
 * @param {unknown} result
 * @returns {string | null}
 */
const readCounts = (result) => {
  if (result === null || typeof result !== "object") return null;
  const value = /** @type {Record<string, unknown>} */ (result);
  const imported = Number(value.imported ?? NaN);
  const unknowns = Number(value.unknowns_added ?? NaN);
  if (!Number.isFinite(imported)) return null;
  const records = `${imported} record${imported === 1 ? "" : "s"}`;
  if (!Number.isFinite(unknowns)) return records;
  return `${records} and ${unknowns} unknown revision${unknowns === 1 ? "" : "s"}`;
};
