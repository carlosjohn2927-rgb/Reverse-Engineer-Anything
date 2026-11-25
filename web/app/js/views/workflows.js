import { api } from "../api.js";
import { completionKindFor } from "../completions.js";
import { errorMessage, h, humanize } from "../dom.js";
import { state } from "../store.js";
import { copyButton, sectionHeader, toast } from "../ui.js";
import {
  guidanceFromSearch,
  guidanceFromSection,
  guidanceSummary,
  validateQuery,
} from "../guidance.js";

/**
 * Workflows view: REA's six MCP prompts.
 *
 * A prompt is not an analysis. It is REA's own instructions for a situation
 * ("investigate this feature", "trace this crash"), with the caller's
 * arguments substituted. The workspace used to ignore the whole capability, so
 * a user had no way to read the workflow REA expects to be followed. Filling
 * in the arguments and reading the result is what makes that reachable.
 */
export const renderWorkflows = (root) => {
  const container = h("div", { class: "stack view-stack" });
  const prompts = state.prompts ?? [];

  if (prompts.length === 0) {
    container.append(
      h(
        "div",
        { class: "empty-state" },
        h("h3", { text: "No workflows advertised" }),
        h("p", {
          text: state.sessionReady
            ? "This REA build does not advertise any MCP prompts."
            : "Start a session to load REA's guided workflows.",
        }),
      ),
    );
    root.replaceChildren(container);
    return { container };
  }

  const cards = h("div", { class: "workflow-grid" });
  for (const prompt of prompts) cards.append(workflowCard(prompt));

  const instructions = state.instructions ?? "";
  container.append(
    h(
      "section",
      { class: "panel" },
      sectionHeader(
        "Workflows",
        `${prompts.length} guided workflows advertised by REA`,
      ),
    ),
    ...(instructions.length === 0
      ? []
      : [
          h(
            "section",
            { class: "panel" },
            sectionHeader(
              "How REA describes itself",
              "Sent once in the MCP handshake; there is no resource for it",
              copyButton("Copy", () => instructions),
            ),
            h(
              "div",
              { class: "panel-body" },
              h("pre", {
                class: "code-block workflow-text",
                text: instructions,
              }),
            ),
          ),
        ]),
    guidancePanel(),
    cards,
  );
  root.replaceChildren(container);
  return { container };
};

/**
 * Fill a `datalist` from REA's completion endpoint and refresh it as the user
 * types. Values depend on the live session (open documents, recorded Evidence),
 * so the list is requested on focus and on input rather than built once.
 *
 * @param {string} promptName
 * @param {string} argumentName
 * @param {HTMLInputElement} input
 * @param {HTMLDataListElement} options
 * @param {() => void} onChange
 */
const loadCompletions = (
  promptName,
  argumentName,
  input,
  options,
  onChange,
) => {
  /** @type {AbortController | null} */
  let inFlight = null;
  /** @type {string | null} */
  let lastQuery = null;
  const refresh = async () => {
    const query = input.value;
    if (query === lastQuery) return;
    lastQuery = query;
    if (inFlight !== null) inFlight.abort();
    const controller = new AbortController();
    inFlight = controller;
    try {
      const result = await api.completePromptArgument(
        promptName,
        argumentName,
        query,
      );
      if (controller.signal.aborted) return;
      options.replaceChildren(
        ...result.values.map((value) => h("option", { value })),
      );
      onChange();
    } catch {
      // Completion is an assist; a failure leaves the user with free text.
      if (!controller.signal.aborted) onChange();
    } finally {
      if (inFlight === controller) inFlight = null;
    }
  };
  input.addEventListener("focus", refresh);
  input.addEventListener("input", refresh);
};

/** One workflow: its arguments, its instructions, and a copy action. */
const workflowCard = (prompt) => {
  const args = prompt.arguments ?? [];
  const output = h("div", { class: "workflow-output" });
  const fields = new Map();

  const inputs = h(
    "div",
    { class: "workflow-args" },
    ...args.map((argument) => {
      const id = `workflow-${prompt.name}-${argument.name}`;
      const kind = completionKindFor(prompt.name, argument.name);
      const listId = `${id}-values`;
      const input = /** @type {HTMLInputElement} */ (
        h("input", {
          id,
          name: argument.name,
          type: "text",
          placeholder: argument.required ? "required" : "optional",
          spellcheck: "false",
          ...(kind === null ? {} : { list: listId, autocomplete: "off" }),
        })
      );
      fields.set(argument.name, input);
      // A completion-kind argument takes a session-owned identifier, so offer
      // the values REA knows about alongside the free-text input.
      const options = /** @type {HTMLDataListElement} */ (
        h("datalist", { id: listId })
      );
      const hint = h("p", { class: "field-hint" });
      const describe = () => {
        const base = argument.description ?? "";
        if (kind === null) {
          hint.textContent = base;
          hint.hidden = base.length === 0;
          return;
        }
        const count = kind === null ? 0 : options.children.length;
        const state =
          count === 0
            ? `no ${kind} values in this session yet — type one`
            : `${count} ${kind} value${count === 1 ? "" : "s"} available`;
        hint.textContent = base.length === 0 ? state : `${base} · ${state}`;
        hint.hidden = false;
      };
      describe();
      if (kind !== null)
        loadCompletions(prompt.name, argument.name, input, options, describe);
      return h(
        "div",
        { class: `form-field ${argument.required ? "required" : ""}` },
        h(
          "div",
          { class: "form-label" },
          h("label", { for: id, text: humanize(argument.name) }),
          argument.required
            ? h("span", { class: "required-dot", title: "Required" })
            : null,
          kind === null
            ? null
            : h("span", { class: "badge", text: kind, title: "Session value" }),
        ),
        input,
        kind === null ? null : options,
        hint,
      );
    }),
  );

  const button = /** @type {HTMLButtonElement} */ (
    h("button", { class: "primary-button", type: "button" }, "Get instructions")
  );
  button.addEventListener("click", async () => {
    const values = {};
    for (const [name, input] of fields)
      if (input.value.trim().length > 0) values[name] = input.value.trim();
    const missing = args
      .filter((argument) => argument.required)
      .filter((argument) => values[argument.name] === undefined)
      .map((argument) => humanize(argument.name));
    if (missing.length > 0) {
      toast(
        "Fill in the required fields",
        `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} required.`,
        "error",
      );
      return;
    }
    button.disabled = true;
    button.textContent = "Loading…";
    output.replaceChildren(
      h("p", { class: "muted", text: "Asking REA for the workflow…" }),
    );
    try {
      const result = await api.getPrompt(prompt.name, values);
      const text =
        result.messages
          .map((message) => message.text)
          .filter((value) => value.length > 0)
          .join("\n\n") || "REA returned no instructions.";
      output.replaceChildren(
        h(
          "div",
          { class: "stack" },
          h(
            "div",
            { class: "row" },
            h("span", {
              class: "badge ok",
              text: `${result.messages.length} message${result.messages.length === 1 ? "" : "s"}`,
            }),
            h("div", { class: "spacer" }),
            copyButton("Copy instructions", () => text),
          ),
          h("pre", { class: "code-block workflow-text", text }),
        ),
      );
    } catch (error) {
      output.replaceChildren(
        h(
          "div",
          { class: "error-card" },
          h("span", { class: "badge bad", text: "failed" }),
          h("h3", { text: errorMessage(error) }),
        ),
      );
    } finally {
      button.disabled = false;
      button.textContent = "Get instructions";
    }
  });

  return h(
    "section",
    { class: "panel workflow-card" },
    sectionHeader(
      prompt.title ?? humanize(prompt.name),
      prompt.description ?? "",
      h("code", { class: "mono faint small", text: prompt.name }),
    ),
    h(
      "div",
      { class: "panel-body stack" },
      inputs,
      h("div", { class: "form-actions" }, button),
      output,
    ),
  );
};

export { humanize };

/**
 * Guidance search.
 *
 * REA installs a guidance bundle and ships two tools over it. The workspace
 * listed both in a "guidance" family and gave no way to call them, so the
 * documented procedure for a task was unreachable unless you already knew the
 * tool name and its locator format. Searching and reading is the whole surface:
 * a result is a section of REA's own documentation, opened by the opaque
 * locator REA minted for it.
 *
 */
const guidancePanel = () => {
  const results = h("div", { class: "guidance-results" });
  const reader = h("div", { class: "guidance-reader" });
  const input = /** @type {HTMLInputElement} */ (
    h("input", {
      type: "search",
      class: "guidance-input",
      placeholder:
        'Search REA\'s installed guidance — "frida", "evidence bundle", "firmware"…',
      value: state.guidanceQuery ?? "",
      onkeydown: (event) => {
        if (/** @type {KeyboardEvent} */ (event).key === "Enter") {
          runSearch().catch(() => undefined);
        }
      },
    })
  );

  /** Run one search and render exactly what REA returned. */
  const runSearch = async () => {
    const query = input.value;
    const valid = validateQuery(query);
    if (!valid.ok) {
      results.replaceChildren(
        h("p", { class: "faint small", text: valid.message }),
      );
      return;
    }
    state.guidanceQuery = query;
    results.replaceChildren(
      h("p", { class: "faint small", text: "Searching REA's guidance…" }),
    );
    reader.replaceChildren();
    try {
      const call = await api.callTool("search_guidance", {
        query: query.trim(),
        limit: 10,
      });
      const payload = unwrapGuidance(call);
      const search = guidanceFromSearch(payload);
      state.guidanceSearch = { query, result: search };
      renderSearch(search);
    } catch (error) {
      state.guidanceSearch = {
        query,
        result: {
          status: "unknown",
          matches: [],
          message: errorMessage(error),
          packageName: null,
          bundleSha256: null,
          total: 0,
        },
      };
      renderSearch(state.guidanceSearch.result);
    }
  };

  /** @param {import("../guidance.js").GuidanceSearch} search */
  const renderSearch = (search) => {
    const summary = h("p", {
      class:
        search.status === "matches" ? "faint small" : "notice-note small warn",
      text: guidanceSummary(search),
    });
    // REA's own message wins over a paraphrase when it sent one.
    const message =
      search.message === null || search.status === "matches"
        ? null
        : h("p", { class: "faint small", text: search.message });
    results.replaceChildren(
      summary,
      ...(message === null ? [] : [message]),
      ...search.matches.map((match) => matchRow(match)),
    );
  };

  /** @param {import("../guidance.js").GuidanceMatch} match */
  const matchRow = (match) =>
    h(
      "button",
      {
        class: "guidance-match",
        type: "button",
        onclick: () => openSection(match.locator).catch(() => undefined),
      },
      h("span", { class: "guidance-heading", text: match.heading }),
      h("span", { class: "mono faint small", text: match.guide }),
      match.matchedTerms.length === 0
        ? null
        : h("span", {
            class: "guidance-terms",
            text: `matched ${match.matchedTerms.join(", ")}`,
          }),
      match.context.length === 0
        ? null
        : h("span", { class: "guidance-context", text: match.context }),
    );

  /** @param {string} locator */
  const openSection = async (locator) => {
    reader.replaceChildren(
      h("p", { class: "faint small", text: "Opening section…" }),
    );
    try {
      const call = await api.callTool("read_guidance_section", { locator });
      const section = guidanceFromSection(unwrapGuidance(call));
      state.guidanceSection = { ...section, locator };
      renderSection(section);
    } catch (error) {
      state.guidanceSection = null;
      reader.replaceChildren(
        h(
          "div",
          { class: "notice warn" },
          h("strong", { text: "REA would not open that section" }),
          h("p", {
            text: errorMessage(error),
          }),
          h("p", {
            class: "small",
            text: "A locator is only valid for the guidance bundle that produced it. Search again after REA updates.",
          }),
        ),
      );
    }
  };

  /** @param {import("../guidance.js").GuidanceSectionResult} section */
  const renderSection = (section) => {
    reader.replaceChildren(
      h(
        "div",
        { class: "guidance-section" },
        h(
          "div",
          { class: "guidance-section-head" },
          h("strong", { text: section.heading ?? "Guidance section" }),
          section.guide === null
            ? null
            : h("span", { class: "mono faint small", text: section.guide }),
          section.packageName === null
            ? null
            : h("span", { class: "faint small", text: section.packageName }),
        ),
        h("p", {
          class: "faint small",
          text: "REA's installed documentation. This describes how to work, not what was found in your target.",
        }),
        h("pre", { class: "code-block workflow-text", text: section.content }),
      ),
    );
    // The section is tall; bring it into view rather than silently swapping
    // content below the fold.
    reader.scrollIntoView?.({ block: "nearest" });
  };

  const panel = h(
    "section",
    { class: "panel" },
    sectionHeader(
      "Guidance search",
      "REA installs its own documentation bundle; search it here",
    ),
    h(
      "div",
      { class: "guidance-search" },
      input,
      h(
        "button",
        {
          class: "ghost-button small",
          type: "button",
          onclick: () => runSearch().catch(() => undefined),
        },
        "Search",
      ),
    ),
    h("p", {
      class: "faint small",
      text: "A search with no matches says nothing about whether a capability exists — only that REA's bundled documentation does not cover the words you typed.",
    }),
    results,
    reader,
  );

  // Restore the last search when the view re-renders, so switching tabs does
  // not discard what the user was reading.
  if (state.guidanceSearch !== null) renderSearch(state.guidanceSearch.result);
  if (state.guidanceSection !== null) renderSection(state.guidanceSection);

  return panel;
};

/**
 * Tool results arrive wrapped in REA's own `result` envelope; guidance payloads
 * use the same shape as every other tool, so unwrap once here.
 *
 * @param {{ payload?: any } | null | undefined} call
 */
const unwrapGuidance = (call) => call?.payload?.result ?? call?.payload ?? null;
