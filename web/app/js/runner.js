import { api } from "./api.js";

/** @typedef {import("./api.js").CallResult} CallResult */
import { byId, errorMessage, h, humanize } from "./dom.js";
import { renderResult } from "./render/evidence.js";
import { recordActivity, recordEvidence } from "./store.js";
import { toast } from "./ui.js";

const drawer = () => byId("drawer");
const scrim = () => byId("drawer-scrim");

const closeDrawer = () => {
  drawer().hidden = true;
  scrim().hidden = true;
  document.body.style.overflow = "";
};

const openDrawer = () => {
  drawer().hidden = false;
  scrim().hidden = false;
  document.body.style.overflow = "hidden";
  drawer().scrollTop = 0;
};

/** Arguments that identify the subject of a call and must stay visible. */
const PRIMARY_INPUT_KEYS = new Set(["path", "input_path", "inputPath"]);

/** A path-like argument: `path`, `input_path`, `parent_unit_path`, ... */
const isPathKey = (key) => PRIMARY_INPUT_KEYS.has(key) || key.endsWith("_path");

/** Human label for a JSON-schema property. */
const labelFor = (key) =>
  key
    .replaceAll("_", " ")
    .replace(/\b\w/gu, (character) => character.toUpperCase());

/** Build one field control for a JSON-schema property. */
const fieldFor = (tool, key, schema, initialValue) => {
  const id = `field-${tool.name}-${key}`;
  const description = schema.description ?? "";
  const common = { id, name: key };

  if (Array.isArray(schema.enum)) {
    const select = h(
      "select",
      common,
      schema.enum.length > 1 || initialValue === undefined
        ? h(
            "option",
            { value: "" },
            schema.default === undefined
              ? "— omit —"
              : `${schema.default} (default)`,
          )
        : null,
      ...schema.enum.map((value) =>
        h(
          "option",
          {
            value: String(value),
            selected:
              String(value) === String(initialValue ?? schema.default ?? ""),
          },
          String(value),
        ),
      ),
    );
    return { key, control: select, kind: "enum", schema };
  }

  if (schema.type === "boolean") {
    const input = h("input", {
      ...common,
      type: "checkbox",
      checked: initialValue === true || schema.default === true,
    });
    return {
      key,
      kind: "boolean",
      schema,
      control: h(
        "label",
        { class: "field-switch" },
        input,
        h("span", { text: description.split(".")[0] || labelFor(key) }),
      ),
    };
  }

  if (schema.type === "integer" || schema.type === "number") {
    const input = h("input", {
      ...common,
      type: "number",
      value: initialValue ?? schema.default ?? "",
      min: schema.minimum,
      max: schema.maximum,
      step: schema.type === "integer" ? 1 : "any",
      placeholder: schema.default === undefined ? "" : String(schema.default),
    });
    return { key, control: input, kind: "number", schema };
  }

  if (schema.type === "array") {
    const input = h("input", {
      ...common,
      type: "text",
      value: Array.isArray(initialValue) ? initialValue.join(", ") : "",
      placeholder: "comma-separated values",
    });
    return { key, control: input, kind: "list", schema };
  }

  if (schema.type === "object" || schema.type === undefined) {
    const input = h("textarea", {
      ...common,
      spellcheck: "false",
      placeholder: "JSON object",
      value:
        initialValue === undefined && schema.default === undefined
          ? ""
          : JSON.stringify(initialValue ?? schema.default, null, 2),
    });
    return { key, control: input, kind: "json", schema };
  }

  const input = h("input", {
    ...common,
    type: "text",
    value: initialValue ?? schema.default ?? "",
    placeholder: schema.default === undefined ? "" : String(schema.default),
    spellcheck: "false",
  });
  return { key, control: input, kind: "string", schema };
};

const readField = (field) => {
  const control =
    field.control.querySelector?.("input, select, textarea") ?? field.control;
  const raw = field.kind === "boolean" ? control.checked : control.value;
  if (field.kind === "boolean") {
    if (schemaDefaultIsFalse(field.schema) && raw === false)
      return { present: false };
    return raw === true ? { present: true, value: true } : { present: false };
  }
  if (typeof raw === "string" && raw.trim().length === 0)
    return { present: false };
  if (field.kind === "number") {
    const value = Number(raw);
    if (!Number.isFinite(value)) return { present: false };
    return { present: true, value };
  }
  if (field.kind === "list")
    return {
      present: true,
      value: String(raw)
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    };
  if (field.kind === "json") {
    try {
      return { present: true, value: JSON.parse(raw) };
    } catch {
      throw new Error(`${labelFor(field.key)} must be valid JSON.`);
    }
  }
  return { present: true, value: raw };
};

const schemaDefaultIsFalse = (schema) => schema.default === false;

/**
 * Open the tool runner for `toolName`, optionally pre-filling `initialArgs`,
 * and immediately run when `autoRun` is set.
 */
export const launchTool = async (
  toolName,
  initialArgs = {},
  { autoRun = false } = {},
) => {
  const tool = (await import("./store.js")).state.toolsByName.get(toolName);
  if (tool === undefined) {
    toast(
      "Unknown tool",
      `${toolName} is not in this session's catalog.`,
      "error",
    );
    return undefined;
  }
  openDrawer();
  byId("drawer-eyebrow").textContent =
    `${tool.cli ?? `rea ${toolName.replaceAll("_", "-")}`}`;
  byId("drawer-title").textContent = tool.title ?? humanize(toolName);
  const body = byId("drawer-body");
  body.replaceChildren();

  const properties = tool.inputSchema?.properties ?? {};
  const required = new Set(tool.inputSchema?.required ?? []);
  const fields = [];
  const form = h("form", { class: "tool-form" });

  const optional = h("div", { class: "tool-form-advanced" });
  let optionalCount = 0;
  // Many REA tools declare no JSON-Schema `required` list even though one
  // path-like argument is mandatory in practice; keep those inputs visible so
  // the primary argument is never hidden behind a disclosure control.
  const hasDeclaredRequired = [...required].some((key) => key in properties);
  const isPrimary = (key) => !hasDeclaredRequired && isPathKey(key);

  for (const [key, schema] of Object.entries(properties)) {
    const field = fieldFor(tool, key, schema, initialArgs[key]);
    fields.push(field);
    const description = schema.description ?? "";
    const wrapper = h(
      "div",
      { class: `form-field ${required.has(key) ? "required" : ""}` },
      h(
        "div",
        { class: "form-label" },
        h("label", { for: `field-${toolName}-${key}`, text: labelFor(key) }),
        required.has(key)
          ? h("span", { class: "required-dot", title: "Required" })
          : null,
        schema.type === undefined
          ? null
          : h("span", { class: "faint mono small", text: String(schema.type) }),
      ),
      field.control,
      description.length === 0
        ? null
        : h("p", { class: "field-hint", text: description }),
    );
    if (required.has(key) || key in initialArgs || isPrimary(key))
      form.append(wrapper);
    else {
      optional.append(wrapper);
      optionalCount += 1;
    }
  }

  if (optionalCount > 0) {
    const toggle = h(
      "button",
      {
        class: "ghost-button small",
        type: "button",
        onclick: () => {
          optional.hidden = !optional.hidden;
          toggle.textContent = optional.hidden
            ? `Show ${optionalCount} optional fields`
            : "Hide optional fields";
        },
      },
      `Show ${optionalCount} optional fields`,
    );
    optional.hidden = true;
    form.append(optional);
    form.append(toggle);
  }

  const output = h("div", { class: "tool-output" });
  /** @type {HTMLButtonElement} */
  /** @type {HTMLButtonElement} */
  const runButton = /** @type {HTMLButtonElement} */ (
    h("button", { class: "primary-button", type: "submit" }, "Run analysis")
  );
  const summary = h(
    "div",
    { class: "tool-summary" },
    h("p", { class: "muted", text: tool.description ?? "" }),
    tool.hostDependent
      ? h("p", {
          class: "badge warn",
          text: "Needs a device, browser or provider on the host",
        })
      : null,
  );

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const args = {};
    try {
      for (const field of fields) {
        const read = readField(field);
        if (read.present) args[field.key] = read.value;
      }
    } catch (error) {
      toast("Check the arguments", errorMessage(error), "error");
      return;
    }
    runButton.disabled = true;
    runButton.textContent = "Running…";
    output.replaceChildren(progressPanel());
    const progressList = /** @type {HTMLElement | null} */ (
      output.querySelector(".progress-log")
    );
    if (progressList === null) throw new Error("Progress panel is missing.");
    try {
      const result = await api.callTool(toolName, args, {
        onProgress: (progress) => {
          const line = h(
            "div",
            { class: "progress-line" },
            h("span", { class: "pulse" }),
            h("span", { class: "mono faint", text: progress.phase }),
            h("span", { text: progress.message.replace(/^[^:]*:\s*/u, "") }),
          );
          progressList.append(line);
          progressList.scrollTop = progressList.scrollHeight;
        },
      });
      output.replaceChildren(renderResult(result));
      const envelope =
        result.payload?.evidence_id === undefined ? null : result.payload;
      const subject = envelope?.subject?.name;
      recordActivity({
        tool: toolName,
        status: result.status,
        durationMs: result.durationMs,
        subject,
        evidenceId: envelope?.evidence_id,
      });
      if (envelope?.evidence_id !== undefined)
        recordEvidence({
          tool: toolName,
          status: result.status,
          payload: result.payload,
          durationMs: result.durationMs,
        });
    } catch (error) {
      output.replaceChildren(
        h(
          "div",
          { class: "error-card" },
          h("span", { class: "badge bad", text: "failed" }),
          h("h3", { text: errorMessage(error) }),
          /** @type {any} */ (error).remediation
            ? h("p", {
                class: "muted",
                text: /** @type {any} */ (error).remediation,
              })
            : null,
        ),
      );
      recordActivity({
        tool: toolName,
        status: "error",
        subject: errorMessage(error).slice(0, 80),
      });
    } finally {
      runButton.disabled = false;
      runButton.textContent = "Run analysis";
    }
  });

  form.append(h("div", { class: "form-actions" }, runButton));

  body.append(summary, form, h("hr", { class: "rule" }), output);

  if (autoRun) /** @type {HTMLFormElement} */ (form).requestSubmit();

  /** @type {Promise<CallResult | undefined>} */
  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      if (drawer().hidden) {
        observer.disconnect();
        resolve(undefined);
      }
    });
    observer.observe(drawer(), {
      attributes: true,
      attributeFilter: ["hidden"],
    });
  });
};

/** Progress panel used while a call streams. */
const progressPanel = () =>
  h(
    "div",
    { class: "result" },
    h(
      "div",
      { class: "result-header" },
      h("span", { class: "spinner-inline" }),
      h("span", { text: "Analysis running" }),
    ),
    h("div", { class: "result-body progress-log" }),
  );

/** Wire the drawer's close affordances once. */
export const initDrawer = () => {
  byId("drawer-close").addEventListener("click", closeDrawer);
  scrim().addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !drawer().hidden) closeDrawer();
  });
};

export { closeDrawer };
