#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/live-common.sh"

VAULT_PATH=""
OWNER=""
REPO=""
BRANCH=""
NAMESPACE=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --vault-path) VAULT_PATH="$2"; shift 2 ;;
    --owner) OWNER="$2"; shift 2 ;;
    --repo) REPO="$2"; shift 2 ;;
    --branch) BRANCH="$2"; shift 2 ;;
    --namespace) NAMESPACE="$2"; shift 2 ;;
    *) lc_die "Unknown argument: $1" ;;
  esac
done

[ -n "$VAULT_PATH" ] || lc_die "--vault-path is required"
[ -n "$OWNER" ] || lc_die "--owner is required"
[ -n "$REPO" ] || lc_die "--repo is required"
[ -n "$BRANCH" ] || lc_die "--branch is required"
[ -n "$NAMESPACE" ] || lc_die "--namespace is required"

lc_require_cmd gh node python3
lc_load_plugin_settings "$VAULT_PATH"
lc_validate_target_matches_settings "$OWNER" "$REPO" "$BRANCH"

RUN_ID="$(lc_run_id)"
REPORT_DIR="$(lc_ensure_report_dir "$RUN_ID")"

lc_safe_remove_local_namespace "$NAMESPACE"
lc_prune_local_manifest_namespace "$NAMESPACE"

lc_write_remote_manifest_subset "$OWNER" "$REPO" "$BRANCH" "$NAMESPACE" "$REPORT_DIR/pre-clean-remote-manifest.json"
node - "$REPORT_DIR/pre-clean-remote-manifest.json" "$NAMESPACE" "$REPORT_DIR/cleanup-payload.json" <<'NODE'
const fs = require("fs");
const [subsetPath, namespace, output] = process.argv.slice(2);
const subset = JSON.parse(fs.readFileSync(subsetPath, "utf8"));
const payload = {
  deletes: Object.keys(subset.files ?? {}),
  manifest: {
    lastSync: subset.lastSync ?? null,
    files: {},
    folders: {},
    deletedFolders: [],
  },
};
fs.writeFileSync(output, JSON.stringify(payload, null, 2));
NODE

node - "$OWNER" "$REPO" "$BRANCH" "$NAMESPACE" "$REPORT_DIR/cleanup-payload.json" <<'NODE'
const fs = require("fs");
const { execFileSync } = require("child_process");
const [owner, repo, branch, namespace, payloadPath] = process.argv.slice(2);
const payload = JSON.parse(fs.readFileSync(payloadPath, "utf8"));
let remoteManifest;
try {
  const response = JSON.parse(execFileSync("gh", ["api", `repos/${owner}/${repo}/contents/.obsidian/github-sync-metadata.json?ref=${branch}`], { encoding: "utf8" }));
  remoteManifest = JSON.parse(Buffer.from(response.content.replace(/\n/g, ""), "base64").toString("utf8"));
} catch {
  remoteManifest = { lastSync: null, files: {}, folders: {}, deletedFolders: [] };
}
function matches(target, root) {
  return target === root || target.startsWith(`${root}/`);
}
for (const key of Object.keys(remoteManifest.files ?? {})) {
  if (matches(key, namespace)) {
    delete remoteManifest.files[key];
  }
}
for (const key of Object.keys(remoteManifest.folders ?? {})) {
  if (matches(key, namespace)) {
    delete remoteManifest.folders[key];
  }
}
remoteManifest.deletedFolders = (remoteManifest.deletedFolders ?? []).filter((path) => !matches(path, namespace));
payload.manifest = remoteManifest;
fs.writeFileSync(payloadPath, JSON.stringify(payload, null, 2));
NODE

lc_apply_remote_mutation "$OWNER" "$REPO" "$BRANCH" "[live-cleanup] prune $NAMESPACE" "$REPORT_DIR/cleanup-payload.json"

lc_write_remote_manifest_subset "$OWNER" "$REPO" "$BRANCH" "$NAMESPACE" "$REPORT_DIR/post-clean-remote-manifest.json"
lc_write_remote_tree_subset "$OWNER" "$REPO" "$BRANCH" "$NAMESPACE" "$REPORT_DIR/post-clean-remote-tree.json"

lc_log "Local namespace removed and remote namespace pruned"
lc_log "Artifacts: $REPORT_DIR"
