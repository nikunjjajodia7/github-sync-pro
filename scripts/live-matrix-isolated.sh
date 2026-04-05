#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
source "$SCRIPT_DIR/live-common.sh"

VAULT_PATH=""
OWNER=""
REPO=""
BRANCH=""
VAULT_ID=""
TIMEOUT_SECONDS=45

while [ "$#" -gt 0 ]; do
  case "$1" in
    --vault-path) VAULT_PATH="$2"; shift 2 ;;
    --owner) OWNER="$2"; shift 2 ;;
    --repo) REPO="$2"; shift 2 ;;
    --branch) BRANCH="$2"; shift 2 ;;
    --vault-id) VAULT_ID="$2"; shift 2 ;;
    --timeout-seconds) TIMEOUT_SECONDS="$2"; shift 2 ;;
    *) lc_die "Unknown argument: $1" ;;
  esac
done

[ -n "$VAULT_PATH" ] || lc_die "--vault-path is required"
[ -n "$OWNER" ] || lc_die "--owner is required"
[ -n "$REPO" ] || lc_die "--repo is required"
[ -n "$BRANCH" ] || lc_die "--branch is required"

lc_require_cmd gh node python3 open
lc_load_plugin_settings "$VAULT_PATH"
lc_validate_target_matches_settings "$OWNER" "$REPO" "$BRANCH"
lc_assert_plugin_enabled "obsidian-advanced-uri"

VAULT_ID="${VAULT_ID:-$LC_VAULT_NAME}"
RUN_ID="$(lc_run_id)"
REPORT_DIR="$(lc_ensure_report_dir "$RUN_ID")"
JSONL_PATH="$REPORT_DIR/scenarios.jsonl"
NAMESPACE="Other Research/__sync-live__/run-$RUN_ID"

lc_settings_summary_json > "$REPORT_DIR/settings-summary.json"
lc_write_duplicate_plugin_report "$REPORT_DIR/plugin-runtime.json"
lc_assert_single_plugin_install "$REPORT_DIR/plugin-runtime.json"

if [ "$(lc_remote_manifest_exists "$OWNER" "$REPO" "$BRANCH")" != "false" ]; then
  lc_die "Isolated branch must start without a remote manifest: $OWNER/$REPO@$BRANCH"
fi

if [ -e "$LC_VAULT_PATH/$NAMESPACE" ]; then
  lc_die "Namespace already exists locally: $NAMESPACE"
fi

lc_write_remote_tree_subset "$OWNER" "$REPO" "$BRANCH" "$NAMESPACE" "$REPORT_DIR/preflight-remote-tree.json"
if [ "$(node - "$REPORT_DIR/preflight-remote-tree.json" <<'NODE'
const fs = require("fs");
console.log(JSON.parse(fs.readFileSync(process.argv[2], "utf8")).length);
NODE
)" != "0" ]; then
  lc_die "Namespace already exists remotely: $NAMESPACE"
fi

record_result() {
  local id="$1"
  local status="$2"
  local summary="$3"
  local artifact_dir="$4"
  lc_append_scenario "$JSONL_PATH" "$id" "$status" "$summary" "$artifact_dir"
}

capture_namespace_artifacts() {
  local label="$1"
  local artifact_dir="$REPORT_DIR/$label"
  mkdir -p "$artifact_dir"
  lc_write_local_manifest_subset "$NAMESPACE" "$artifact_dir/local-manifest.json"
  lc_write_remote_manifest_subset "$OWNER" "$REPO" "$BRANCH" "$NAMESPACE" "$artifact_dir/remote-manifest.json"
  lc_write_remote_tree_subset "$OWNER" "$REPO" "$BRANCH" "$NAMESPACE" "$artifact_dir/remote-tree.json"
  printf '%s\n' "$artifact_dir"
}

run_sync_and_collect() {
  local label="$1"
  local prefix="${2:-}"
  local artifact_dir="$REPORT_DIR/$label"
  mkdir -p "$artifact_dir"
  local start_iso
  start_iso="$(lc_now_iso)"
  lc_trigger_sync "$VAULT_ID"
  lc_wait_for_sync_completion "$start_iso" "$TIMEOUT_SECONDS" "$artifact_dir/sync-result.json"
  if [ -n "$prefix" ]; then
    lc_write_log_lines_since "$start_iso" "$artifact_dir/log-lines.json" "$prefix"
  else
    lc_write_log_lines_since "$start_iso" "$artifact_dir/log-lines.json"
  fi
}

assert_sync_result() {
  local result_path="$1"
  node - "$result_path" <<'NODE'
const fs = require("fs");
const result = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (!result.started || !result.completed || !["Sync done", "Nothing to sync"].includes(result.terminalMessage)) {
  process.exit(1);
}
NODE
}

mkdir -p "$LC_VAULT_PATH/$NAMESPACE"

run_sync_and_collect "01-bootstrap"
BOOTSTRAP_ARTIFACTS="$(capture_namespace_artifacts "01-bootstrap")"
if assert_sync_result "$REPORT_DIR/01-bootstrap/sync-result.json" && [ "$(lc_remote_manifest_exists "$OWNER" "$REPO" "$BRANCH")" = "true" ]; then
  record_result "bootstrap" "pass" "Created the remote manifest on an isolated branch with no prior manifest" "$BOOTSTRAP_ARTIFACTS"
else
  record_result "bootstrap" "fail" "Failed to create the remote manifest on the isolated branch" "$BOOTSTRAP_ARTIFACTS"
fi

LOCAL_NOTE="$NAMESPACE/local-note.md"
printf '# Local note\ncreated at %s\n' "$(date -u)" > "$LC_VAULT_PATH/$LOCAL_NOTE"
sleep 1
run_sync_and_collect "02-local-note-upload" "$NAMESPACE"
LOCAL_NOTE_ARTIFACTS="$(capture_namespace_artifacts "02-local-note-upload")"
if assert_sync_result "$REPORT_DIR/02-local-note-upload/sync-result.json" && \
  node - "$REPORT_DIR/02-local-note-upload" "$LOCAL_NOTE" <<'NODE'
const fs = require("fs");
const artifactDir = process.argv[2];
const notePath = process.argv[3];
const local = JSON.parse(fs.readFileSync(`${artifactDir}/local-manifest.json`, "utf8"));
const remote = JSON.parse(fs.readFileSync(`${artifactDir}/remote-manifest.json`, "utf8"));
const tree = JSON.parse(fs.readFileSync(`${artifactDir}/remote-tree.json`, "utf8"));
const localEntry = local.files?.[notePath];
const remoteEntry = remote.files?.[notePath];
if (!localEntry || !remoteEntry || localEntry.dirty !== false || remoteEntry.dirty !== false) {
  process.exit(1);
}
if (!tree.some((entry) => entry.path === notePath && entry.type === "blob")) {
  process.exit(1);
}
NODE
then
  record_result "local_note_upload" "pass" "Uploaded a fresh local note and cleared dirty state locally and remotely" "$LOCAL_NOTE_ARTIFACTS"
else
  record_result "local_note_upload" "fail" "Fresh local note upload did not converge cleanly" "$LOCAL_NOTE_ARTIFACTS"
fi

rm -f "$LC_VAULT_PATH/$LOCAL_NOTE"
sleep 1
run_sync_and_collect "03-local-note-delete" "$NAMESPACE"
LOCAL_DELETE_ARTIFACTS="$(capture_namespace_artifacts "03-local-note-delete")"
if assert_sync_result "$REPORT_DIR/03-local-note-delete/sync-result.json" && \
  node - "$REPORT_DIR/03-local-note-delete" "$LOCAL_NOTE" <<'NODE'
const fs = require("fs");
const artifactDir = process.argv[2];
const notePath = process.argv[3];
const remote = JSON.parse(fs.readFileSync(`${artifactDir}/remote-manifest.json`, "utf8"));
const tree = JSON.parse(fs.readFileSync(`${artifactDir}/remote-tree.json`, "utf8"));
const entry = remote.files?.[notePath];
if (!entry || entry.deleted !== true) {
  process.exit(1);
}
if (tree.some((item) => item.path === notePath)) {
  process.exit(1);
}
NODE
then
  record_result "local_note_delete" "pass" "Propagated a local delete to the remote tree and manifest" "$LOCAL_DELETE_ARTIFACTS"
else
  record_result "local_note_delete" "fail" "Local delete did not propagate to the remote tree and manifest" "$LOCAL_DELETE_ARTIFACTS"
fi

REMOTE_CREATE_PATH="$NAMESPACE/remote-created.md"
cat > "$REPORT_DIR/remote-create.json" <<EOF
{
  "upserts": [
    {
      "path": "$REMOTE_CREATE_PATH",
      "content": "# Remote created\ncreated by live-matrix-isolated.sh\n"
    }
  ]
}
EOF
lc_apply_remote_mutation "$OWNER" "$REPO" "$BRANCH" "[live-matrix] add remote-created.md" "$REPORT_DIR/remote-create.json"
run_sync_and_collect "04-remote-note-create" "$NAMESPACE"
REMOTE_CREATE_ARTIFACTS="$(capture_namespace_artifacts "04-remote-note-create")"
if assert_sync_result "$REPORT_DIR/04-remote-note-create/sync-result.json" && \
  [ -f "$LC_VAULT_PATH/$REMOTE_CREATE_PATH" ] && \
  node - "$REPORT_DIR/04-remote-note-create" "$REMOTE_CREATE_PATH" <<'NODE'
const fs = require("fs");
const artifactDir = process.argv[2];
const notePath = process.argv[3];
const local = JSON.parse(fs.readFileSync(`${artifactDir}/local-manifest.json`, "utf8"));
const remote = JSON.parse(fs.readFileSync(`${artifactDir}/remote-manifest.json`, "utf8"));
if (!local.files?.[notePath] || !remote.files?.[notePath] || local.files[notePath].deleted || remote.files[notePath].deleted) {
  process.exit(1);
}
NODE
then
  record_result "remote_note_create" "pass" "Downloaded a remote-only note into the isolated vault" "$REMOTE_CREATE_ARTIFACTS"
else
  record_result "remote_note_create" "fail" "Remote note create did not converge into the isolated vault" "$REMOTE_CREATE_ARTIFACTS"
fi

cat > "$REPORT_DIR/remote-delete.json" <<EOF
{
  "deletes": [
    "$REMOTE_CREATE_PATH"
  ]
}
EOF
lc_apply_remote_mutation "$OWNER" "$REPO" "$BRANCH" "[live-matrix] delete remote-created.md" "$REPORT_DIR/remote-delete.json"
run_sync_and_collect "05-remote-note-delete" "$NAMESPACE"
REMOTE_DELETE_ARTIFACTS="$(capture_namespace_artifacts "05-remote-note-delete")"
if assert_sync_result "$REPORT_DIR/05-remote-note-delete/sync-result.json" && \
  [ ! -f "$LC_VAULT_PATH/$REMOTE_CREATE_PATH" ] && \
  node - "$REPORT_DIR/05-remote-note-delete" "$REMOTE_CREATE_PATH" <<'NODE'
const fs = require("fs");
const artifactDir = process.argv[2];
const notePath = process.argv[3];
const local = JSON.parse(fs.readFileSync(`${artifactDir}/local-manifest.json`, "utf8"));
const remote = JSON.parse(fs.readFileSync(`${artifactDir}/remote-manifest.json`, "utf8"));
if (!local.files?.[notePath] || !remote.files?.[notePath] || local.files[notePath].deleted !== true || remote.files[notePath].deleted !== true) {
  process.exit(1);
}
NODE
then
  record_result "remote_note_delete" "pass" "Applied a remote delete locally and recorded tombstones" "$REMOTE_DELETE_ARTIFACTS"
else
  record_result "remote_note_delete" "fail" "Remote delete did not remove the local note cleanly" "$REMOTE_DELETE_ARTIFACTS"
fi

mkdir -p "$LC_VAULT_PATH/$NAMESPACE/empty-folder"
sleep 1
run_sync_and_collect "06-empty-folder-create" "$NAMESPACE"
EMPTY_CREATE_ARTIFACTS="$(capture_namespace_artifacts "06-empty-folder-create")"
if assert_sync_result "$REPORT_DIR/06-empty-folder-create/sync-result.json" && \
  node - "$REPORT_DIR/06-empty-folder-create" "$NAMESPACE/empty-folder" <<'NODE'
const fs = require("fs");
const artifactDir = process.argv[2];
const folderPath = process.argv[3];
const local = JSON.parse(fs.readFileSync(`${artifactDir}/local-manifest.json`, "utf8"));
const remote = JSON.parse(fs.readFileSync(`${artifactDir}/remote-manifest.json`, "utf8"));
const tree = JSON.parse(fs.readFileSync(`${artifactDir}/remote-tree.json`, "utf8"));
if (!local.folders?.[folderPath] || !remote.folders?.[folderPath]) {
  process.exit(1);
}
if (tree.some((entry) => entry.path === folderPath || entry.path.startsWith(`${folderPath}/`))) {
  process.exit(1);
}
NODE
then
  record_result "empty_folder_create" "pass" "Propagated an empty folder via manifest-only folder metadata" "$EMPTY_CREATE_ARTIFACTS"
else
  record_result "empty_folder_create" "fail" "Empty folder create did not stay manifest-only" "$EMPTY_CREATE_ARTIFACTS"
fi

mv "$LC_VAULT_PATH/$NAMESPACE/empty-folder" "$LC_VAULT_PATH/$NAMESPACE/empty-renamed"
sleep 1
run_sync_and_collect "07-empty-folder-rename" "$NAMESPACE"
EMPTY_RENAME_ARTIFACTS="$(capture_namespace_artifacts "07-empty-folder-rename")"
if assert_sync_result "$REPORT_DIR/07-empty-folder-rename/sync-result.json" && \
  node - "$REPORT_DIR/07-empty-folder-rename" "$NAMESPACE/empty-folder" "$NAMESPACE/empty-renamed" <<'NODE'
const fs = require("fs");
const artifactDir = process.argv[2];
const oldPath = process.argv[3];
const newPath = process.argv[4];
const remote = JSON.parse(fs.readFileSync(`${artifactDir}/remote-manifest.json`, "utf8"));
if (!remote.folders?.[oldPath] || remote.folders[oldPath].deleted !== true) {
  process.exit(1);
}
if (!remote.folders?.[newPath] || remote.folders[newPath].deleted !== false) {
  process.exit(1);
}
NODE
then
  record_result "empty_folder_rename" "pass" "Recorded an empty folder rename using folder tombstones and live folder state" "$EMPTY_RENAME_ARTIFACTS"
else
  record_result "empty_folder_rename" "fail" "Empty folder rename did not persist correctly" "$EMPTY_RENAME_ARTIFACTS"
fi

rm -rf "$LC_VAULT_PATH/$NAMESPACE/empty-renamed"
sleep 1
run_sync_and_collect "08-empty-folder-delete" "$NAMESPACE"
EMPTY_DELETE_ARTIFACTS="$(capture_namespace_artifacts "08-empty-folder-delete")"
if assert_sync_result "$REPORT_DIR/08-empty-folder-delete/sync-result.json" && \
  node - "$REPORT_DIR/08-empty-folder-delete" "$NAMESPACE/empty-renamed" <<'NODE'
const fs = require("fs");
const artifactDir = process.argv[2];
const path = process.argv[3];
const remote = JSON.parse(fs.readFileSync(`${artifactDir}/remote-manifest.json`, "utf8"));
const tree = JSON.parse(fs.readFileSync(`${artifactDir}/remote-tree.json`, "utf8"));
if (!remote.folders?.[path] || remote.folders[path].deleted !== true) {
  process.exit(1);
}
if (tree.some((entry) => entry.path === path || entry.path.startsWith(`${path}/`))) {
  process.exit(1);
}
NODE
then
  record_result "empty_folder_delete" "pass" "Deleted an empty folder without leaving live remote tree entries" "$EMPTY_DELETE_ARTIFACTS"
else
  record_result "empty_folder_delete" "fail" "Empty folder delete did not produce a clean tombstone-only state" "$EMPTY_DELETE_ARTIFACTS"
fi

HEAD_BEFORE="$(lc_remote_head "$OWNER" "$REPO" "$BRANCH")"
run_sync_and_collect "09-no-op" "$NAMESPACE"
NOOP_ARTIFACTS="$(capture_namespace_artifacts "09-no-op")"
HEAD_AFTER="$(lc_remote_head "$OWNER" "$REPO" "$BRANCH")"
if assert_sync_result "$REPORT_DIR/09-no-op/sync-result.json" && [ "$HEAD_BEFORE" = "$HEAD_AFTER" ]; then
  record_result "no_op_sync" "pass" "No-op sync left the isolated branch head unchanged" "$NOOP_ARTIFACTS"
else
  record_result "no_op_sync" "fail" "No-op sync advanced the isolated branch or failed to converge" "$NOOP_ARTIFACTS"
fi

mkdir -p "$LC_VAULT_PATH/$NAMESPACE/folder-delete"
printf 'a\n' > "$LC_VAULT_PATH/$NAMESPACE/folder-delete/a.md"
printf 'b\n' > "$LC_VAULT_PATH/$NAMESPACE/folder-delete/b.md"
sleep 1
run_sync_and_collect "10-folder-delete-baseline" "$NAMESPACE"
rm -rf "$LC_VAULT_PATH/$NAMESPACE/folder-delete"
sleep 1
run_sync_and_collect "10-folder-delete" "$NAMESPACE"
FOLDER_DELETE_ARTIFACTS="$(capture_namespace_artifacts "10-folder-delete")"
if assert_sync_result "$REPORT_DIR/10-folder-delete/sync-result.json" && \
  node - "$REPORT_DIR/10-folder-delete" "$NAMESPACE/folder-delete" <<'NODE'
const fs = require("fs");
const artifactDir = process.argv[2];
const folderPath = process.argv[3];
const remote = JSON.parse(fs.readFileSync(`${artifactDir}/remote-manifest.json`, "utf8"));
const tree = JSON.parse(fs.readFileSync(`${artifactDir}/remote-tree.json`, "utf8"));
const deletedFiles = Object.keys(remote.files ?? {}).filter((path) => path.startsWith(`${folderPath}/`));
if (deletedFiles.length < 2) {
  process.exit(1);
}
if (!deletedFiles.every((path) => remote.files[path].deleted === true)) {
  process.exit(1);
}
if (tree.some((entry) => entry.path.startsWith(`${folderPath}/`))) {
  process.exit(1);
}
NODE
then
  record_result "folder_with_files_delete" "pass" "Propagated a folder-with-files delete through file tombstones and remote tree cleanup" "$FOLDER_DELETE_ARTIFACTS"
else
  record_result "folder_with_files_delete" "fail" "Folder-with-files delete did not fully propagate" "$FOLDER_DELETE_ARTIFACTS"
fi

mkdir -p "$LC_VAULT_PATH/$NAMESPACE/adopt-me/empty"
printf 'adopt me\n' > "$LC_VAULT_PATH/$NAMESPACE/adopt-me/note.md"
sleep 1
node - "$LC_MANIFEST_PATH" "$NAMESPACE/adopt-me" <<'NODE'
const fs = require("fs");
const [manifestPath, namespace] = process.argv.slice(2);
function matches(target, root) {
  return target === root || target.startsWith(`${root}/`);
}
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
for (const key of Object.keys(manifest.files ?? {})) {
  if (matches(key, namespace)) {
    delete manifest.files[key];
  }
}
for (const key of Object.keys(manifest.folders ?? {})) {
  if (matches(key, namespace)) {
    delete manifest.folders[key];
  }
}
manifest.deletedFolders = (manifest.deletedFolders ?? []).filter((path) => !matches(path, namespace));
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
NODE
run_sync_and_collect "11-adoption" "$NAMESPACE/adopt-me"
ADOPTION_ARTIFACTS="$(capture_namespace_artifacts "11-adoption")"
if assert_sync_result "$REPORT_DIR/11-adoption/sync-result.json" && \
  node - "$REPORT_DIR/11-adoption" "$NAMESPACE/adopt-me/note.md" "$NAMESPACE/adopt-me/empty" <<'NODE'
const fs = require("fs");
const artifactDir = process.argv[2];
const notePath = process.argv[3];
const folderPath = process.argv[4];
const local = JSON.parse(fs.readFileSync(`${artifactDir}/local-manifest.json`, "utf8"));
const remote = JSON.parse(fs.readFileSync(`${artifactDir}/remote-manifest.json`, "utf8"));
if (!local.files?.[notePath] || !remote.files?.[notePath]) {
  process.exit(1);
}
if (!local.folders?.[folderPath] || !remote.folders?.[folderPath]) {
  process.exit(1);
}
NODE
then
  record_result "adoption_missing_metadata" "pass" "Adopted missing local file and folder metadata from a non-empty namespace" "$ADOPTION_ARTIFACTS"
else
  record_result "adoption_missing_metadata" "fail" "Adoption did not recover missing local file and folder metadata" "$ADOPTION_ARTIFACTS"
fi

mkdir -p "$LC_VAULT_PATH/$NAMESPACE/legacy-folder"
printf 'legacy\n' > "$LC_VAULT_PATH/$NAMESPACE/legacy-folder/known.md"
sleep 1
run_sync_and_collect "12-legacy-baseline" "$NAMESPACE"
lc_write_remote_manifest_subset "$OWNER" "$REPO" "$BRANCH" "$NAMESPACE" "$REPORT_DIR/12-legacy-remote-before.json"
node - "$REPORT_DIR/12-legacy-remote-before.json" "$NAMESPACE/legacy-folder" "$NAMESPACE/legacy-folder/known.md" "$REPORT_DIR/12-legacy-payload.json" <<'NODE'
const fs = require("fs");
const [subsetPath, folderPath, filePath, output] = process.argv.slice(2);
const subset = JSON.parse(fs.readFileSync(subsetPath, "utf8"));
subset.files[filePath] = {
  ...(subset.files[filePath] ?? { path: filePath, sha: null, dirty: false, justDownloaded: false, lastModified: 1 }),
  deleted: true,
  deletedAt: Date.now(),
  dirty: false,
};
subset.deletedFolders = Array.from(new Set([...(subset.deletedFolders ?? []), folderPath]));
const payload = {
  deletes: [filePath],
  manifest: subset,
};
fs.writeFileSync(output, JSON.stringify(payload, null, 2));
NODE
node - "$REPORT_DIR/12-legacy-payload.json" "$OWNER" "$REPO" "$BRANCH" <<'NODE'
const fs = require("fs");
const { execFileSync } = require("child_process");
const [payloadPath, owner, repo, branch] = process.argv.slice(2);
const payload = JSON.parse(fs.readFileSync(payloadPath, "utf8"));
let remoteManifest;
try {
  const response = JSON.parse(execFileSync("gh", ["api", `repos/${owner}/${repo}/contents/.obsidian/github-sync-metadata.json?ref=${branch}`], { encoding: "utf8" }));
  remoteManifest = JSON.parse(Buffer.from(response.content.replace(/\n/g, ""), "base64").toString("utf8"));
} catch {
  remoteManifest = { lastSync: null, files: {}, folders: {}, deletedFolders: [] };
}
for (const [path, value] of Object.entries(payload.manifest.files ?? {})) {
  remoteManifest.files[path] = value;
}
for (const path of payload.manifest.deletedFolders ?? []) {
  if (!remoteManifest.deletedFolders.includes(path)) {
    remoteManifest.deletedFolders.push(path);
  }
}
payload.manifest = remoteManifest;
fs.writeFileSync(payloadPath, JSON.stringify(payload, null, 2));
NODE
lc_apply_remote_mutation "$OWNER" "$REPO" "$BRANCH" "[live-matrix] patch legacy deletedFolders" "$REPORT_DIR/12-legacy-payload.json"
run_sync_and_collect "12-legacy-deleted-folders" "$NAMESPACE/legacy-folder"
LEGACY_ARTIFACTS="$(capture_namespace_artifacts "12-legacy-deleted-folders")"
if assert_sync_result "$REPORT_DIR/12-legacy-deleted-folders/sync-result.json" && \
  [ ! -f "$LC_VAULT_PATH/$NAMESPACE/legacy-folder/known.md" ] && \
  node - "$REPORT_DIR/12-legacy-deleted-folders" "$NAMESPACE/legacy-folder/known.md" "$NAMESPACE/legacy-folder" <<'NODE'
const fs = require("fs");
const artifactDir = process.argv[2];
const filePath = process.argv[3];
const folderPath = process.argv[4];
const local = JSON.parse(fs.readFileSync(`${artifactDir}/local-manifest.json`, "utf8"));
const remote = JSON.parse(fs.readFileSync(`${artifactDir}/remote-manifest.json`, "utf8"));
if (!local.files?.[filePath] || local.files[filePath].deleted !== true) {
  process.exit(1);
}
if (!remote.deletedFolders?.includes(folderPath)) {
  process.exit(1);
}
NODE
then
  record_result "legacy_deleted_folders" "pass" "Respected a remote manifest that only carried legacy deletedFolders intent" "$LEGACY_ARTIFACTS"
else
  record_result "legacy_deleted_folders" "fail" "Legacy deletedFolders compatibility did not delete local descendants" "$LEGACY_ARTIFACTS"
fi

lc_finalize_report \
  "$JSONL_PATH" \
  "$REPORT_DIR/report.json" \
  "$REPORT_DIR/report.md" \
  "isolated-live-matrix" \
  "$RUN_ID" \
  "$NAMESPACE" \
  "$OWNER" \
  "$REPO" \
  "$BRANCH"

lc_log "Wrote report to $REPORT_DIR/report.md"
