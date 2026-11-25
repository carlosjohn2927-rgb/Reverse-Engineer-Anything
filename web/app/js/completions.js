/**
 * Which prompt arguments carry session-owned identifiers.
 *
 * REA turns on MCP `completions` and asks the client to fill 14 of the 25
 * guided-workflow arguments from the live session: document names, procedures,
 * Evidence ids, captures, manifests, occurrences and unknowns. Only `provider`
 * has values that do not depend on the session — it is the fixed provider list.
 *
 * `prompts/list` does not carry this information: the argument objects come
 * back with a name, description and required flag only. The mapping therefore
 * mirrors `src/contracts/promptContracts.ts` and is asserted against the live
 * `completion/complete` response by `web/test/prompt-completions.mjs`, so a
 * contract change fails a test instead of silently degrading to free text.
 *
 * A completion kind with no values is not an error: `document` and `procedure`
 * are empty until a provider has analysed a target, and the UI must let the
 * user type a value anyway.
 */

/**
 * Completion kinds REA defines, in the order its contract declares them.
 * @type {readonly string[]}
 */
export const COMPLETION_KINDS = Object.freeze([
  "document",
  "procedure",
  "provider",
  "evidence",
  "capture",
  "manifest",
  "occurrence",
  "unknown",
]);

/**
 * Prompt name -> argument name -> completion kind.
 * @type {Readonly<Record<string, Readonly<Record<string, string>>>>}
 */
export const PROMPT_COMPLETIONS = Object.freeze({
  investigate_feature: Object.freeze({
    document: "document",
    procedure: "procedure",
    provider_id: "provider",
  }),
  compare_application_versions: Object.freeze({
    left_manifest_id: "manifest",
    right_manifest_id: "manifest",
    focus_occurrence_id: "occurrence",
  }),
  verify_reconstruction: Object.freeze({
    comparison_evidence_id: "evidence",
    provider_id: "provider",
  }),
  trace_crash: Object.freeze({
    document: "document",
    procedure: "procedure",
    capture_evidence_id: "capture",
  }),
  audit_residual_unknowns: Object.freeze({
    unknown_id: "unknown",
    evidence_id: "evidence",
  }),
  prepare_bounded_process_capture: Object.freeze({
    prior_capture_evidence_id: "capture",
  }),
});

/**
 * Completion kind for one prompt argument, or null when the argument is free
 * text.
 *
 * @param {string} promptName
 * @param {string} argumentName
 * @returns {string | null}
 */
export const completionKindFor = (promptName, argumentName) =>
  PROMPT_COMPLETIONS[promptName]?.[argumentName] ?? null;

/** Every prompt argument that expects a completion, as `prompt/argument`. */
export const completionArgumentKeys = () =>
  Object.entries(PROMPT_COMPLETIONS).flatMap(([prompt, args]) =>
    Object.keys(args).map((argument) => `${prompt}/${argument}`),
  );
