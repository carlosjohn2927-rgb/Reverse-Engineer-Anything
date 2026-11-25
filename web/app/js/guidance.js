/**
 * Guidance search: REA's installed documentation, made reachable.
 *
 * REA ships a guidance bundle and two tools over it — `search_guidance` and
 * `read_guidance_section`. The workspace listed both under a "guidance" family
 * and gave a user no way to call either, so the instructions REA expects to be
 * followed were unreachable from the UI. The prompts in the Workflows view are
 * a different, narrower surface: six fixed workflows with arguments, not 3
 * searchable guides.
 *
 * Two properties are REA's, not ours, and are preserved here rather than
 * paraphrased:
 *
 *  - A no-match answer is explicitly *not* a capability verdict. REA says so
 *    itself: "This does not indicate whether an analysis capability is
 *    available." A failed search must never become "this can't be done".
 *  - A locator is an opaque, bundle-anchored token. It is valid only for the
 *    bundle it came from, so this module never builds one, rewrites one or
 *    keeps one across a bundle change.
 *
 * `matched_terms` is REA's explanation of *why* a section matched. Rendering it
 * is what separates a search result from a guess.
 */

/** REA's own words for an empty result. Quoted, never reworded. */
export const NO_MATCH_IS_NOT_A_VERDICT =
  "This does not indicate whether an analysis capability is available.";

/** Where the guidance came from. Shown so a section is never mistaken for evidence. */
export const GUIDANCE_SOURCE = "installed_rea_guidance";

/**
 * @typedef {object} GuidanceMatch
 * @property {string} guide path inside the bundle, e.g. `references/frida.md`
 * @property {string} heading section heading
 * @property {string} locator opaque token for `read_guidance_section`
 * @property {string[]} matchedTerms terms REA says occurred in the section
 * @property {string} relevance REA's sentence about the match
 * @property {string} context snippet around the match
 */

/**
 * @typedef {object} GuidanceSearch
 * @property {"matches" | "no_matches" | "unknown"} status
 * @property {GuidanceMatch[]} matches
 * @property {string | null} message REA's own sentence, unedited
 * @property {string | null} packageName
 * @property {string | null} bundleSha256 a locator is only valid for this bundle
 * @property {number} total
 */

/**
 * @typedef {object} GuidanceSectionResult
 * @property {string | null} heading
 * @property {string | null} guide
 * @property {string} content
 * @property {string | null} packageName
 * @property {boolean} stale the locator referred to a different bundle
 */

/**
 * Normalize a `search_guidance` payload.
 *
 * @param {unknown} payload the tool result, already unwrapped from `result`
 * @returns {GuidanceSearch}
 */
export const guidanceFromSearch = (payload) => {
  /** @type {ReturnType<typeof guidanceFromSearch>} */
  const empty = {
    status: "unknown",
    matches: [],
    message: null,
    packageName: null,
    bundleSha256: null,
    total: 0,
  };
  if (payload === null || typeof payload !== "object") return empty;
  const value = /** @type {Record<string, any>} */ (payload);

  const rawMatches = Array.isArray(value.matches) ? value.matches : [];
  const matches = rawMatches
    .map((entry) => matchFrom(entry))
    .filter((entry) => entry !== null);

  // Trust REA's status, but never let a status of "matches" with no usable
  // rows render as a successful search.
  const status =
    value.status === "matches" && matches.length > 0
      ? "matches"
      : value.status === "no_matches" || matches.length === 0
        ? "no_matches"
        : "unknown";

  return {
    status,
    matches,
    message: typeof value.message === "string" ? value.message : null,
    packageName: typeof value.package === "string" ? value.package : null,
    bundleSha256:
      typeof value.bundle_sha256 === "string" ? value.bundle_sha256 : null,
    total: Number.isFinite(value.total_matches)
      ? Number(value.total_matches)
      : matches.length,
  };
};

/**
 * @param {unknown} entry
 * @returns {GuidanceMatch | null}
 */
const matchFrom = (entry) => {
  if (entry === null || typeof entry !== "object") return null;
  const value = /** @type {Record<string, any>} */ (entry);
  // A row without a locator cannot be opened, so it is not a result.
  if (typeof value.locator !== "string" || value.locator.length === 0)
    return null;
  return {
    guide: typeof value.guide === "string" ? value.guide : "(unknown guide)",
    heading:
      typeof value.heading === "string" && value.heading.length > 0
        ? value.heading
        : "(untitled section)",
    locator: value.locator,
    matchedTerms: Array.isArray(value.matched_terms)
      ? value.matched_terms.filter((term) => typeof term === "string")
      : [],
    relevance: typeof value.relevance === "string" ? value.relevance : "",
    context: typeof value.context === "string" ? value.context : "",
  };
};

/**
 * Normalize a `read_guidance_section` payload.
 *
 * A section is documentation. It is reported with its guide and heading so it
 * can never be read as an observation about the user's target.
 *
 * @param {unknown} payload
 * @returns {GuidanceSectionResult}
 */
export const guidanceFromSection = (payload) => {
  /** @type {GuidanceSectionResult} */
  const empty = {
    heading: null,
    guide: null,
    content: "",
    packageName: null,
    stale: false,
  };
  if (payload === null || typeof payload !== "object") return empty;
  const value = /** @type {Record<string, any>} */ (payload);
  return {
    heading: typeof value.heading === "string" ? value.heading : null,
    guide: typeof value.guide === "string" ? value.guide : null,
    content: typeof value.content === "string" ? value.content : "",
    packageName: typeof value.package === "string" ? value.package : null,
    // A locator is valid only for the bundle that minted it. If REA reports a
    // different bundle the token is stale and must be searched for again.
    stale:
      typeof value.status === "string" &&
      value.status !== "section" &&
      value.status !== "matches",
  };
};

/**
 * The one sentence that keeps a search from reading as a capability report.
 *
 * @param {{ status: string, total: number, packageName: string | null }} search
 */
export const guidanceSummary = (search) => {
  const source =
    search.packageName === null
      ? "REA's installed guidance"
      : search.packageName;
  if (search.status === "matches")
    return `${search.total} section${search.total === 1 ? "" : "s"} matched in ${source}. Guidance is documentation, not a finding about your target.`;
  if (search.status === "no_matches")
    return `No section in ${source} matched. ${NO_MATCH_IS_NOT_A_VERDICT}`;
  return `REA did not answer the guidance search. ${NO_MATCH_IS_NOT_A_VERDICT}`;
};

/**
 * Reject a query the tool would reject, before spending a round trip, and say
 * which limit was hit rather than a generic failure.
 *
 * @param {string} query
 * @returns {{ ok: true } | { ok: false, message: string }}
 */
export const validateQuery = (query) => {
  const trimmed = query.trim();
  if (trimmed.length === 0)
    return { ok: false, message: "Type something to search for." };
  if (trimmed.length > 2048)
    return {
      ok: false,
      message: `Guidance queries are limited to 2048 characters; this one is ${trimmed.length}.`,
    };
  return { ok: true };
};
