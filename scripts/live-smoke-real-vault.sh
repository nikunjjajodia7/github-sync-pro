#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/live-common.sh"

VAULT_PATH=""
NAMESPACE_ROOT="Other Research/__sync-smoke__"
VAULT_ID=""
TIMEOUT_SECONDS=45

while [ "$#" -gt 0 ]; do
  case "$1" in
    --vault-path) VAULT_PATH="$2"; shift 2 ;;
    --namespace-root) NAMESPACE_ROOT="$2"; shift 2 ;;
    --vault-id) VAULT_ID="$2"; shift 2 ;;
    --timeout-seconds) TIMEOUT_SECONDS="$2"; shift 2 ;;
    *) lc_die "Unknown argument: $1" ;;
  esac
done

[ -n "$VAULT_PATH" ] || lc_die "--vault-path is required"

lc_require_cmd gh node python3 open
lc_load_plugin_settings "$VAULT_PATH"
lc_assert_plugin_enabled "$PLUGIN_ID"
lc_assert_plugin_enabled "obsidian-advanced-uri"

VAULT_ID="${VAULT_ID:-$LC_VAULT_NAME}"
RUN_ID="$(lc_run_id)"
REPORT_DIR="$(lc_ensure_report_dir "$RUN_ID")"
JSONL_PATH="$REPORT_DIR/scenarios.jsonl"
NAMESPACE="$NAMESPACE_ROOT/run-$RUN_ID"

lc_settings_summary_json > "$REPORT_DIR/settings-summary.json"
lc_write_duplicate_plugin_report "$REPORT_DIR/plugin-runtime.json"

record_result() {
  local id="$1"
  local status="$2"
  local summary="$3"
  local artifact_dir="$4"
  lc_append_scenario "$JSONL_PATH" "$id" "$status" "$summary" "$artifact_dir"
}

capture_artifacts() {
  local label="$1"
  local prefix="${2:-$NAMESPACE}"
  local artifact_dir="$REPORT_DIR/$label"
  mkdir -p "$artifact_dir"
  lc_write_local_manifest_subset "$prefix" "$artifact_dir/local-manifest.json"
  lc_write_remote_manifest_subset "$LC_OWNER" "$LC_REPO" "$LC_BRANCH" "$prefix" "$artifact_dir/remote-manifest.json"
  lc_write_remote_tree_subset "$LC_OWNER" "$LC_REPO" "$LC_BRANCH" "$prefix" "$artifact_dir/remote-tree.json"
  printf '%s\n' "$artifact_dir"
}

run_sync() {
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

assert_sync_ok() {
  local result_path="$1"
  node - "$result_path" <<'NODE'
const fs = require("fs");
const result = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (!result.started || !["Sync done", "Nothing to sync"].includes(result.terminalMessage)) {
  process.exit(1);
}
NODE
}

PLUGIN_VERSION="$(node - "$LC_PLUGIN_MANIFEST_PATH" <<'NODE'
const fs = require("fs");
console.log(JSON.parse(fs.readFileSync(process.argv[2], "utf8")).version);
NODE
)"
RUNTIME_ARTIFACTS="$(capture_artifacts "01-runtime" "$NAMESPACE_ROOT")"
if lc_assert_single_plugin_install "$REPORT_DIR/plugin-runtime.json"; then
  record_result "runtime_load_verification" "pass" "Found exactly one installed plugin copy and manifest version $PLUGIN_VERSION" "$RUNTIME_ARTIFACTS"
else
  record_result "runtime_load_verification" "fail" "Duplicate plugin installs detected; runtime cannot be trusted" "$RUNTIME_ARTIFACTS"
fi

run_sync "02-sync-command"
SYNC_ARTIFACTS="$(capture_artifacts "02-sync-command" "$NAMESPACE_ROOT")"
if assert_sync_ok "$REPORT_DIR/02-sync-command/sync-result.json"; then
  record_result "sync_command" "pass" "Real vault accepted the sync command and reached a terminal state" "$SYNC_ARTIFACTS"
else
  record_result "sync_command" "fail" "Real vault sync command did not reach a clean terminal state" "$SYNC_ARTIFACTS"
fi

mkdir -p "$LC_VAULT_PATH/$NAMESPACE/empty-folder"
sleep 1
run_sync "03-empty-folder" "$NAMESPACE"
EMPTY_ARTIFACTS="$(capture_artifacts "03-empty-folder")"
if assert_sync_ok "$REPORT_DIR/03-empty-folder/sync-result.json" && \
  node - "$REPORT_DIR/03-empty-folder" "$NAMESPACE/empty-folder" <<'NODE'
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
  record_result "namespaced_empty_folder_adoption" "pass" "Real vault propagated an empty smoke folder through manifest-only folder metadata" "$EMPTY_ARTIFACTS"
else
  record_result "namespaced_empty_folder_adoption" "fail" "Real vault did not keep the smoke empty folder in manifest-only state" "$EMPTY_ARTIFACTS"
fi

NOTE_PATH="$NAMESPACE/fresh-note.md"
printf '# Smoke note\ncreated at %s\n' "$(date -u)" > "$LC_VAULT_PATH/$NOTE_PATH"
sleep 1
run_sync "04-fresh-note" "$NAMESPACE"
NOTE_ARTIFACTS="$(capture_artifacts "04-fresh-note")"
if assert_sync_ok "$REPORT_DIR/04-fresh-note/sync-result.json" && \
  node - "$REPORT_DIR/04-fresh-note" "$NOTE_PATH" <<'NODE'
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
  record_result "namespaced_fresh_note_upload" "pass" "Real vault uploaded a smoke note and cleared dirty state on both sides" "$NOTE_ARTIFACTS"
else
  record_result "namespaced_fresh_note_upload" "fail" "Real vault smoke note upload did not clear dirty state cleanly" "$NOTE_ARTIFACTS"
fi

run_sync "05-no-op" "$NAMESPACE"
NOOP_ARTIFACTS="$(capture_artifacts "05-no-op")"
if assert_sync_ok "$REPORT_DIR/05-no-op/sync-result.json"; then
  record_result "no_op_smoke_rerun" "pass" "Real vault reran sync without namespace-scoped errors" "$NOOP_ARTIFACTS"
else
  record_result "no_op_smoke_rerun" "fail" "Real vault rerun reported an error after smoke changes" "$NOOP_ARTIFACTS"
fi

rm -rf "$LC_VAULT_PATH/$NAMESPACE"
sleep 1
run_sync "06-cleanup" "$NAMESPACE_ROOT"
CLEANUP_ARTIFACTS="$(capture_artifacts "06-cleanup" "$NAMESPACE_ROOT")"
if assert_sync_ok "$REPORT_DIR/06-cleanup/sync-result.json" && \
  node - "$REPORT_DIR/06-cleanup" "$NAMESPACE" <<'NODE'
const fs = require("fs");
const artifactDir = process.argv[2];
const namespace = process.argv[3];
const local = JSON.parse(fs.readFileSync(`${artifactDir}/local-manifest.json`, "utf8"));
const remote = JSON.parse(fs.readFileSync(`${artifactDir}/remote-manifest.json`, "utf8"));
const tree = JSON.parse(fs.readFileSync(`${artifactDir}/remote-tree.json`, "utf8"));
const hasLiveLocalFile = Object.values(local.files ?? {}).some((entry) => entry.deleted !== true);
const hasLiveRemoteFile = Object.values(remote.files ?? {}).some((entry) => entry.deleted !== true);
const hasLiveRemoteFolder = Object.values(remote.folders ?? {}).some((entry) => entry.deleted !== true);
if (hasLiveLocalFile || hasLiveRemoteFile || hasLiveRemoteFolder) {
  process.exit(1);
}
if (tree.some((entry) => entry.path === namespace || entry.path.startsWith(`${namespace}/`))) {
  process.exit(1);
}
NODE
then
  record_result "cleanup_verification" "pass" "Real vault smoke namespace cleaned up without leaving live remote entries" "$CLEANUP_ARTIFACTS"
else
  record_result "cleanup_verification" "fail" "Smoke cleanup left live namespace entries behind" "$CLEANUP_ARTIFACTS"
fi

lc_finalize_report \
  "$JSONL_PATH" \
  "$REPORT_DIR/real-vault-smoke.json" \
  "$REPORT_DIR/real-vault-smoke.md" \
  "real-vault-smoke" \
  "$RUN_ID" \
  "$NAMESPACE" \
  "$LC_OWNER" \
  "$LC_REPO" \
  "$LC_BRANCH"

lc_log "Wrote report to $REPORT_DIR/real-vault-smoke.md"
