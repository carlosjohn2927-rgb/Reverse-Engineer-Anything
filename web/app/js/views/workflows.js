import { api } from "../api.js";
import { errorMessage, h, humanize } from "../dom.js";
import { state } from "../store.js";
import { copyButton, sectionHeader, toast } from "../ui.js";

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

  container.append(
    h(
      "section",
      { class: "panel" },
      sectionHeader(
        "Workflows",
        `${prompts.length} guided workflows advertised by REA`,
      ),
    ),
    cards,
  );
  root.replaceChildren(container);
  return { container };
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
      const input = h("input", {
        id,
        name: argument.name,
        type: "text",
        placeholder: argument.required ? "required" : "optional",
        spellcheck: "false",
      });
      fields.set(argument.name, input);
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
        ),
        input,
        argument.description === undefined || argument.description === ""
          ? null
          : h("p", { class: "field-hint", text: argument.description }),
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
