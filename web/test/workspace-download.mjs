/** Session-scoped folder uploads and downloads for workspace artifacts. */
const base = process.argv[2] ?? "http://127.0.0.1:4180";
const failures = [];
const check = (label, ok, detail = "") => {
  if (!ok) failures.push(`${label} ${detail}`.trim());
  console.log(
    `${ok ? "ok  " : "FAIL"} ${label}${detail === "" ? "" : ` — ${detail}`}`,
  );
};

const startSession = async () => {
  const response = await fetch(`${base}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  return { status: response.status, session: await response.json() };
};
const first = await startSession();
const second = await startSession();
check(
  "sessions start for workspace download tests",
  first.status === 201 || first.status === 200,
);
const sessionId = first.session.sessionId;
const otherSessionId = second.session.sessionId;
const name = "website-crawl-test-script.js";
const source = "console.log('download me');";

const staged = await fetch(`${base}/api/workspace/text`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-rea-session": sessionId,
  },
  body: JSON.stringify({ name, text: source }),
});
check(
  "a file is staged into its owning session workspace",
  staged.status === 201,
);

const folderResponse = await fetch(`${base}/api/folder-uploads`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-rea-session": sessionId,
  },
  body: JSON.stringify({ name: "sample-app" }),
});
const folder = await folderResponse.json();
check(
  "a browser folder upload gets a session-owned destination",
  folderResponse.status === 201,
);
const relativePath = "src/main.js";
const folderSource = "export const ready = true;";
const folderFileResponse = await fetch(
  `${base}/api/folder-uploads/file?folderId=${encodeURIComponent(folder.folderId)}&path=${encodeURIComponent(relativePath)}`,
  {
    method: "PUT",
    headers: {
      "content-type": "application/octet-stream",
      "x-rea-session": sessionId,
    },
    body: folderSource,
  },
);
const folderFile = await folderFileResponse.json();
check(
  "folder uploads preserve nested relative paths",
  folderFileResponse.status === 201 &&
    folderFile.relativePath === relativePath &&
    folderFile.path === `${folder.path}/${relativePath}`,
);
const { readFile } = await import("node:fs/promises");
check(
  "folder uploads retain the original file bytes",
  (await readFile(folderFile.path, "utf8")) === folderSource,
);
const folderTraversal = await fetch(
  `${base}/api/folder-uploads/file?folderId=${encodeURIComponent(folder.folderId)}&path=${encodeURIComponent("../escape.js")}`,
  {
    method: "PUT",
    headers: {
      "content-type": "application/octet-stream",
      "x-rea-session": sessionId,
    },
    body: "bad",
  },
);
check(
  "folder upload paths cannot escape their destination",
  folderTraversal.status === 400,
);

const downloaded = await fetch(
  `${base}/api/workspace/download?name=${encodeURIComponent(name)}`,
  { headers: { "x-rea-session": sessionId } },
);
const downloadedText = await downloaded.text();
check(
  "the owning session can download the saved bytes",
  downloaded.status === 200 && downloadedText === source,
  `${downloaded.status} · ${downloadedText}`,
);
check(
  "downloads are attachments with safe response headers",
  downloaded.headers
    .get("content-disposition")
    ?.includes(`filename="${name}"`) === true &&
    downloaded.headers.get("cache-control") === "no-store" &&
    downloaded.headers.get("x-content-type-options") === "nosniff",
);

const traversal = await fetch(
  `${base}/api/workspace/download?name=${encodeURIComponent("../secret")}`,
  { headers: { "x-rea-session": sessionId } },
);
check(
  "download paths cannot escape the session workspace",
  traversal.status === 400,
);

const missing = await fetch(
  `${base}/api/workspace/download?name=not-present.js`,
  { headers: { "x-rea-session": sessionId } },
);
check("missing workspace files are reported", missing.status === 404);

const isolated = await fetch(
  `${base}/api/workspace/download?name=${encodeURIComponent(name)}`,
  { headers: { "x-rea-session": otherSessionId } },
);
check("another session cannot download the file", isolated.status === 404);

const unauthenticated = await fetch(
  `${base}/api/workspace/download?name=${encodeURIComponent(name)}`,
);
check(
  "a session is required to download workspace files",
  unauthenticated.status === 400,
);

await Promise.all(
  [sessionId, otherSessionId].map((id) =>
    fetch(`${base}/api/sessions`, {
      method: "DELETE",
      headers: { "x-rea-session": id },
    }),
  ),
);

if (failures.length > 0) {
  console.error(`\nworkspace-download: ${failures.length} failure(s).`);
  process.exit(1);
}
console.log("\nworkspace-download: all checks passed.");
