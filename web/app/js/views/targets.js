import { api } from "../api.js";
import { byId, errorMessage, formatBytes, h, inputOf } from "../dom.js";
import { addTarget, set, state } from "../store.js";
import { sectionHeader, toast } from "../ui.js";
import { launchTool } from "../runner.js";
import { renderWebsiteFlow } from "./website.js";

/**
 * Targets view: connect a browser page, browse local applications, upload files,
 * or generate samples. Local folders can be opened as JavaScript applications.
 */
export const renderTargets = (root) => {
  const container = h("div", { class: "stack view-stack" });
  const websitePanel = renderWebsiteFlow();
  const browserPanel = h("section", { class: "panel" });
  const manualPanel = h("section", { class: "panel" });

  const manualInput = h("input", {
    type: "text",
    placeholder: "/absolute/path/to/app-or-binary",
    spellcheck: "false",
  });
  const folderUploadPanel = h("section", { class: "panel" });
  const folderStatus = h("p", {
    id: "folder-upload-status",
    class: "faint small",
    role: "status",
    "aria-live": "polite",
  });
  const folderInput = h("input", {
    id: "local-folder-input",
    type: "file",
    webkitdirectory: true,
    directory: true,
    multiple: true,
    hidden: true,
    onchange: () => {
      void uploadSelectedFolder();
    },
  });
  const folderButton = h(
    "button",
    {
      class: "primary-button",
      type: "button",
      onclick: () => folderInput.click(),
    },
    "Choose folder & analyse",
  );
  folderUploadPanel.append(
    sectionHeader(
      "Inspect a folder from this device",
      "Upload a JavaScript or Electron app folder into this REA session",
    ),
    h(
      "div",
      { class: "panel-body folder-upload-body" },
      h("p", {
        class: "muted",
        text: "REA cannot read folders on your computer directly. Choose a folder to copy its files into this private session, preserving their directory layout; REA then runs the JavaScript application analyzer.",
      }),
      h("p", {
        class: "field-hint",
        text: "Uploads are limited to 300 files and 150 MiB per folder. node_modules, .git, build, dist, coverage and common cache folders are skipped.",
      }),
      h("div", { class: "row" }, folderButton, folderInput),
      folderStatus,
    ),
  );

  manualPanel.append(
    sectionHeader("Open a path", "Any absolute path the server can read"),
    h(
      "div",
      { class: "panel-body" },
      h(
        "form",
        {
          class: "row",
          onsubmit: (event) => {
            event.preventDefault();
            const path = inputOf(event).value.trim();
            if (path.length === 0) return;
            const stored = addTarget({
              name: path.split("/").pop() || path,
              path,
            });
            set({ selectedTarget: stored });
            toast("Target added", path);
            renderTree(state.lastTree ?? []);
          },
        },
        h("div", { class: "grow" }, manualInput),
        h("button", { class: "primary-button", type: "submit" }, "Add target"),
      ),
      h("p", {
        class: "faint pad-top",
        text: "Directories are analysed as JavaScript/Electron applications; files use their artifact extension to suggest tools.",
      }),
    ),
  );

  container.append(folderUploadPanel, browserPanel, manualPanel, websitePanel);
  root.replaceChildren(container);

  let tree = [];
  const renderTree = (nodes) => {
    state.lastTree = nodes;
    const filter = (/** @type {HTMLInputElement | null} */
    (browserPanel.querySelector(".tree-filter"))?.value ?? "").toLowerCase();
    const visible = nodes.filter(
      (node) =>
        node.kind === "directory" ||
        filter.length === 0 ||
        node.name.toLowerCase().includes(filter),
    );
    browserPanel.replaceChildren(
      sectionHeader(
        "Local sources",
        state.status?.repositoryRoot ?? "",
        h("span", { class: "badge", text: `${nodes.length} entries` }),
      ),
      h(
        "div",
        { class: "tree-toolbar" },
        h("input", {
          class: "tree-filter",
          type: "search",
          placeholder: "Filter by name…",
          oninput: (event) => renderList(inputOf(event).value.toLowerCase()),
        }),
      ),
      h("div", { class: "tree-list" }, ...rowsFor(visible)),
    );
    const list = /** @type {HTMLElement | null} */ (
      browserPanel.querySelector(".tree-list")
    );
    if (list === null) throw new Error("Tree list is missing.");
    /** @param {string} value */
    const renderList = (value) =>
      list.replaceChildren(
        ...rowsFor(
          nodes.filter(
            (node) =>
              node.kind === "directory" ||
              value.length === 0 ||
              node.name.toLowerCase().includes(value),
          ),
        ),
      );
  };

  const rowsFor = (nodes) =>
    nodes.slice(0, 500).map((node) =>
      h(
        "div",
        {
          class: `tree-row depth-${Math.min(node.depth, 3)}`,
          role: "button",
          tabindex: "0",
          onclick: () => choose(node),
          onkeydown: (event) => {
            const key = /** @type {KeyboardEvent} */ (event);
            if (key.key === "Enter" || key.key === " ") choose(node);
          },
        },
        h("span", {
          class: "tree-kind",
          text:
            node.kind === "directory"
              ? "DIR"
              : node.inspectable
                ? "BIN"
                : "FILE",
        }),
        h("span", { class: "mono tree-name", text: node.name }),
        h("span", { class: "spacer" }),
        node.bytes === undefined
          ? null
          : h("span", { class: "faint", text: formatBytes(node.bytes) }),
        node.inspectable
          ? h("span", { class: "badge info", text: "inspectable" })
          : null,
      ),
    );

  const choose = async (node) => {
    if (node.kind === "directory") {
      const absolute = node.absolute ?? node.path;
      const stored = addTarget({
        name: node.name,
        path: absolute,
        kind: "folder",
      });
      set({ selectedTarget: stored });
      toast(
        "Folder added",
        `${node.name} — run “Analyse JavaScript application” from the workspace.`,
      );
      return;
    }
    const stored = addTarget({
      name: node.name,
      path: node.absolute ?? node.path,
      bytes: node.bytes,
    });
    set({ selectedTarget: stored });
    toast("Target added", node.name);
  };

  async function uploadSelectedFolder() {
    const selectedFiles = [...(folderInput.files ?? [])];
    folderInput.value = "";
    if (selectedFiles.length === 0) return;

    const firstRelativePath = selectedFiles[0]?.webkitRelativePath;
    const rootName =
      (typeof firstRelativePath === "string" && firstRelativePath.length > 0
        ? firstRelativePath.split(/[\\/]/u)[0]
        : selectedFiles[0]?.name.split(".")[0]) ?? "local-app";
    const skippedDirectories = new Set([
      ".git",
      ".next",
      ".nuxt",
      ".cache",
      ".venv",
      "build",
      "coverage",
      "dist",
      "node_modules",
    ]);
    const files = selectedFiles
      .map((file) => {
        const sourcePath = file.webkitRelativePath || file.name;
        const segments = sourcePath.split(/[\\/]/u);
        const relativeSegments =
          segments[0] === rootName ? segments.slice(1) : segments;
        return { file, relativePath: relativeSegments.join("/") };
      })
      .filter(
        ({ file, relativePath }) =>
          relativePath.length > 0 &&
          !relativePath
            .split("/")
            .slice(0, -1)
            .some((segment) => skippedDirectories.has(segment)),
      );
    const totalBytes = files.reduce((total, { file }) => total + file.size, 0);
    if (files.length === 0) {
      folderStatus.textContent =
        "No usable files were found in that folder after skipping generated and dependency directories.";
      return;
    }
    if (files.length > 300 || totalBytes > 150 * 1024 * 1024) {
      folderStatus.textContent =
        "This selection exceeds the limit of 300 files or 150 MiB. Exclude generated output and dependency folders, then try again.";
      return;
    }

    folderButton.disabled = true;
    folderStatus.textContent = `Preparing ${rootName} · ${String(files.length)} files (${formatBytes(totalBytes)})…`;
    try {
      const upload = await api.createFolderUpload(rootName);
      let next = 0;
      let uploaded = 0;
      let uploadFailure;
      const workers = Array.from(
        { length: Math.min(4, files.length) },
        async () => {
          while (next < files.length && uploadFailure === undefined) {
            const index = next;
            next += 1;
            const item = files[index];
            if (item === undefined) continue;
            try {
              await api.uploadFolderFile(
                upload.folderId,
                item.relativePath,
                item.file,
              );
              uploaded += 1;
              folderStatus.textContent = `Uploading ${rootName} · ${String(uploaded)} of ${String(files.length)} files`;
            } catch (error) {
              uploadFailure = error;
              throw error;
            }
          }
        },
      );
      const uploadResults = await Promise.allSettled(workers);
      const rejectedUpload = uploadResults.find(
        (result) => result.status === "rejected",
      );
      if (rejectedUpload?.status === "rejected") throw rejectedUpload.reason;
      const target = addTarget({
        name: upload.name,
        path: upload.path,
        kind: "folder",
        bytes: totalBytes,
      });
      set({ selectedTarget: target });
      const currentStatus = document.getElementById("folder-upload-status");
      if (currentStatus !== null)
        currentStatus.textContent = `Uploaded ${String(uploaded)} files. Starting JavaScript application analysis…`;
      toast(
        "Folder uploaded",
        `${upload.name} is staged in this session; starting the JavaScript analyzer.`,
        "info",
      );
      void launchTool(
        "analyze_javascript_application",
        { input_path: upload.path },
        { autoRun: true },
      ).catch((error) => {
        const status = document.getElementById("folder-upload-status");
        if (status !== null)
          status.textContent = `The folder was uploaded, but analysis could not start: ${errorMessage(error)}`;
        toast("Could not analyze the folder", errorMessage(error), "error");
      });
    } catch (error) {
      folderStatus.textContent = `Folder upload failed: ${errorMessage(error)}`;
      toast("Folder upload failed", errorMessage(error), "error");
    } finally {
      folderButton.disabled = false;
    }
  }

  api
    .sources()
    .then((payload) => {
      tree = payload.nodes;
      renderTree(tree);
    })
    .catch((error) => {
      browserPanel.replaceChildren(
        sectionHeader("Local sources", "Unavailable"),
        h(
          "div",
          { class: "empty-state" },
          h("h3", { text: "Could not read the workspace" }),
          h("p", { text: errorMessage(error) }),
        ),
      );
    });

  return { container };
};
