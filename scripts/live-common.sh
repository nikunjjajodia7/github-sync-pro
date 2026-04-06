#!/usr/bin/env bash

set -euo pipefail

LIVE_COMMON_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$LIVE_COMMON_DIR/.." && pwd)"
PLUGIN_ID="github-gitless-sync-enhanced"
MANIFEST_REL=".obsidian/github-sync-metadata.json"

lc_log() {
  printf '[live-test] %s\n' "$*" >&2
}

lc_die() {
  lc_log "ERROR: $*"
  exit 1
}

lc_require_cmd() {
  local missing=()
  for cmd in "$@"; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
      missing+=("$cmd")
    fi
  done
  if [ "${#missing[@]}" -gt 0 ]; then
    lc_die "Missing required commands: ${missing[*]}"
  fi
}

lc_run_id() {
  date -u +"%Y%m%d-%H%M%S"
}

lc_now_iso() {
  python3 - <<'PY'
from datetime import datetime, timezone
print(datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"))
PY
}

lc_urlencode() {
  python3 - "$1" <<'PY'
import sys
from urllib.parse import quote
print(quote(sys.argv[1], safe=""))
PY
}

lc_ensure_report_dir() {
  local run_id="$1"
  local dir="$REPO_ROOT/.context/live-sync-runs/$run_id"
  mkdir -p "$dir"
  printf '%s\n' "$dir"
}

lc_load_plugin_settings() {
  local vault_path="$1"
  export LC_VAULT_PATH="$(cd "$vault_path" && pwd)"
  export LC_VAULT_NAME="$(basename "$LC_VAULT_PATH")"
  export LC_PLUGIN_DIR="$LC_VAULT_PATH/.obsidian/plugins/$PLUGIN_ID"
  export LC_SETTINGS_PATH="$LC_PLUGIN_DIR/data.json"
  export LC_MANIFEST_PATH="$LC_VAULT_PATH/$MANIFEST_REL"
  export LC_LOG_PATH="$LC_VAULT_PATH/.obsidian/github-sync.log"
  export LC_COMMUNITY_PLUGINS_PATH="$LC_VAULT_PATH/.obsidian/community-plugins.json"
  export LC_PLUGIN_MANIFEST_PATH="$LC_PLUGIN_DIR/manifest.json"

  [ -d "$LC_PLUGIN_DIR" ] || lc_die "Plugin directory missing: $LC_PLUGIN_DIR"
  [ -f "$LC_SETTINGS_PATH" ] || lc_die "Plugin settings missing: $LC_SETTINGS_PATH"
  [ -f "$LC_MANIFEST_PATH" ] || lc_die "Vault manifest missing: $LC_MANIFEST_PATH"
  [ -f "$LC_PLUGIN_MANIFEST_PATH" ] || lc_die "Plugin manifest missing: $LC_PLUGIN_MANIFEST_PATH"

  eval "$(
    python3 - "$LC_SETTINGS_PATH" <<'PY'
import json
import shlex
import sys

data = json.load(open(sys.argv[1]))
values = {
    "LC_OWNER": data.get("githubOwner", ""),
    "LC_REPO": data.get("githubRepo", ""),
    "LC_BRANCH": data.get("githubBranch", ""),
    "LC_SYNC_SCOPE_MODE": data.get("syncScopeMode", ""),
    "LC_SYNC_STRATEGY": data.get("syncStrategy", ""),
    "LC_SYNC_CONFIG_DIR": str(bool(data.get("syncConfigDir", False))).lower(),
    "LC_ENABLE_LOGGING": str(bool(data.get("enableLogging", False))).lower(),
    "LC_FIRST_SYNC": str(bool(data.get("firstSync", False))).lower(),
    "LC_TOKEN_PRESENT": str(bool(data.get("githubToken", ""))).lower(),
}
for key, value in values.items():
    print(f"{key}={shlex.quote(value)}")
PY
  )"
}

lc_settings_summary_json() {
  node - "$LC_SETTINGS_PATH" "$LC_PLUGIN_MANIFEST_PATH" <<'NODE'
const fs = require("fs");
const settings = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const manifest = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
console.log(JSON.stringify({
  pluginId: manifest.id,
  pluginVersion: manifest.version,
  owner: settings.githubOwner,
  repo: settings.githubRepo,
  branch: settings.githubBranch,
  syncScopeMode: settings.syncScopeMode,
  syncStrategy: settings.syncStrategy,
  syncConfigDir: Boolean(settings.syncConfigDir),
  enableLogging: Boolean(settings.enableLogging),
  firstSync: Boolean(settings.firstSync),
  tokenPresent: Boolean(settings.githubToken),
}, null, 2));
NODE
}

lc_validate_target_matches_settings() {
  local owner="$1"
  local repo="$2"
  local branch="$3"

  [ "$LC_OWNER" = "$owner" ] || lc_die "Vault owner mismatch: expected $owner, found $LC_OWNER"
  [ "$LC_REPO" = "$repo" ] || lc_die "Vault repo mismatch: expected $repo, found $LC_REPO"
  [ "$LC_BRANCH" = "$branch" ] || lc_die "Vault branch mismatch: expected $branch, found $LC_BRANCH"
}

lc_plugin_enabled() {
  local plugin_id="$1"
  node - "$LC_COMMUNITY_PLUGINS_PATH" "$plugin_id" <<'NODE'
const fs = require("fs");
const path = process.argv[2];
const pluginId = process.argv[3];
if (!fs.existsSync(path)) {
  console.log("false");
  process.exit(0);
}
const enabled = JSON.parse(fs.readFileSync(path, "utf8"));
console.log(Array.isArray(enabled) && enabled.includes(pluginId) ? "true" : "false");
NODE
}

lc_assert_plugin_enabled() {
  local plugin_id="$1"
  local enabled
  enabled="$(lc_plugin_enabled "$plugin_id")"
  [ "$enabled" = "true" ] || lc_die "Required plugin is not enabled: $plugin_id"
}

lc_write_duplicate_plugin_report() {
  local output_path="$1"
  node - "$LC_VAULT_PATH" "$PLUGIN_ID" "$output_path" <<'NODE'
const fs = require("fs");
const path = require("path");

const vault = process.argv[2];
const pluginId = process.argv[3];
const output = process.argv[4];
const pluginsDir = path.join(vault, ".obsidian", "plugins");
const duplicates = [];

if (fs.existsSync(pluginsDir)) {
  for (const entry of fs.readdirSync(pluginsDir)) {
    const manifestPath = path.join(pluginsDir, entry, "manifest.json");
    if (!fs.existsSync(manifestPath)) {
      continue;
    }
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      if (manifest.id === pluginId) {
        duplicates.push({
          directory: path.relative(vault, path.join(pluginsDir, entry)),
          manifestPath: path.relative(vault, manifestPath),
          version: manifest.version ?? null,
        });
      }
    } catch (error) {
      duplicates.push({
        directory: path.relative(vault, path.join(pluginsDir, entry)),
        manifestPath: path.relative(vault, manifestPath),
        parseError: String(error),
      });
    }
  }
}

fs.writeFileSync(output, JSON.stringify({
  pluginId,
  matches: duplicates,
  duplicateCount: duplicates.length,
}, null, 2));
NODE
}

lc_assert_single_plugin_install() {
  local report_path="$1"
  local duplicate_count
  duplicate_count="$(
    node - "$report_path" <<'NODE'
const fs = require("fs");
const report = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
console.log(report.duplicateCount);
NODE
  )"
  [ "$duplicate_count" = "1" ]
}

lc_write_local_manifest_subset() {
  local prefix="$1"
  local output_path="$2"
  node - "$LC_MANIFEST_PATH" "$prefix" "$output_path" <<'NODE'
const fs = require("fs");

const manifestPath = process.argv[2];
const prefix = process.argv[3];
const output = process.argv[4];

function matches(target, root) {
  return target === root || target.startsWith(`${root}/`);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const files = Object.fromEntries(
  Object.entries(manifest.files ?? {}).filter(([path]) => matches(path, prefix)),
);
const folders = Object.fromEntries(
  Object.entries(manifest.folders ?? {}).filter(([path]) => matches(path, prefix)),
);
const deletedFolders = (manifest.deletedFolders ?? []).filter((path) => matches(path, prefix));

fs.writeFileSync(output, JSON.stringify({
  lastSync: manifest.lastSync ?? null,
  files,
  folders,
  deletedFolders,
}, null, 2));
NODE
}

lc_write_remote_manifest_subset() {
  local owner="$1"
  local repo="$2"
  local branch="$3"
  local prefix="$4"
  local output_path="$5"
  node - "$owner" "$repo" "$branch" "$prefix" "$output_path" <<'NODE'
const fs = require("fs");
const { execFileSync } = require("child_process");

const [owner, repo, branch, prefix, output] = process.argv.slice(2);

function matches(target, root) {
  return target === root || target.startsWith(`${root}/`);
}

function readRemoteManifest() {
  try {
    const payload = JSON.parse(
      execFileSync(
        "gh",
        ["api", `repos/${owner}/${repo}/contents/.obsidian/github-sync-metadata.json?ref=${branch}`],
        { encoding: "utf8" },
      ),
    );
    const content = Buffer.from(payload.content.replace(/\n/g, ""), "base64").toString("utf8");
    return JSON.parse(content);
  } catch {
    return { lastSync: null, files: {}, folders: {}, deletedFolders: [] };
  }
}

const manifest = readRemoteManifest();
const files = Object.fromEntries(
  Object.entries(manifest.files ?? {}).filter(([path]) => matches(path, prefix)),
);
const folders = Object.fromEntries(
  Object.entries(manifest.folders ?? {}).filter(([path]) => matches(path, prefix)),
);
const deletedFolders = (manifest.deletedFolders ?? []).filter((path) => matches(path, prefix));

fs.writeFileSync(output, JSON.stringify({
  lastSync: manifest.lastSync ?? null,
  files,
  folders,
  deletedFolders,
}, null, 2));
NODE
}

lc_write_remote_tree_subset() {
  local owner="$1"
  local repo="$2"
  local branch="$3"
  local prefix="$4"
  local output_path="$5"
  node - "$owner" "$repo" "$branch" "$prefix" "$output_path" <<'NODE'
const fs = require("fs");
const { execFileSync } = require("child_process");

const [owner, repo, branch, prefix, output] = process.argv.slice(2);

function matches(target, root) {
  return target === root || target.startsWith(`${root}/`);
}

const response = JSON.parse(
  execFileSync("gh", ["api", `repos/${owner}/${repo}/git/trees/${branch}?recursive=1`], {
    encoding: "utf8",
  }),
);
const entries = (response.tree ?? []).filter((entry) => matches(entry.path, prefix));
fs.writeFileSync(output, JSON.stringify(entries, null, 2));
NODE
}

lc_write_log_lines_since() {
  local start_iso="$1"
  local output_path="$2"
  local prefix="${3:-}"
  node - "$LC_LOG_PATH" "$start_iso" "$output_path" "$prefix" <<'NODE'
const fs = require("fs");

const [logPath, startIso, output, prefix] = process.argv.slice(2);
const lines = [];

if (fs.existsSync(logPath)) {
  for (const rawLine of fs.readFileSync(logPath, "utf8").split(/\r?\n/)) {
    if (!rawLine.trim()) {
      continue;
    }
    try {
      const entry = JSON.parse(rawLine);
      if ((entry.timestamp ?? "") < startIso) {
        continue;
      }
      if (prefix) {
        const additional = JSON.stringify(entry.additional_data ?? "");
        const message = String(entry.message ?? "");
        if (!additional.includes(prefix) && !message.includes(prefix)) {
          continue;
        }
      }
      lines.push(entry);
    } catch {
      lines.push({ raw: rawLine, parseError: true });
    }
  }
}

fs.writeFileSync(output, JSON.stringify(lines, null, 2));
NODE
}

lc_remote_head() {
  local owner="$1"
  local repo="$2"
  local branch="$3"
  gh api "repos/$owner/$repo/git/ref/heads/$branch" --jq '.object.sha'
}

lc_remote_manifest_exists() {
  local owner="$1"
  local repo="$2"
  local branch="$3"
  if gh api "repos/$owner/$repo/contents/.obsidian/github-sync-metadata.json?ref=$branch" >/dev/null 2>&1; then
    printf 'true\n'
  else
    printf 'false\n'
  fi
}

lc_trigger_sync() {
  local vault_id="${1:-$LC_VAULT_NAME}"
  local uri
  uri="obsidian://adv-uri?vault=$(lc_urlencode "$vault_id")&commandid=$(lc_urlencode "${PLUGIN_ID}:sync-files")"
  lc_log "Triggering sync via $uri"
  open "$uri"
}

lc_wait_for_sync_completion() {
  local start_iso="$1"
  local timeout_seconds="$2"
  local output_path="$3"
  node - "$LC_LOG_PATH" "$start_iso" "$timeout_seconds" "$output_path" <<'NODE'
const fs = require("fs");

const [logPath, startIso, timeoutSeconds, output] = process.argv.slice(2);
const timeoutMs = Number(timeoutSeconds) * 1000;
const terminalMessages = new Set(["Sync done", "Nothing to sync"]);

function readLines() {
  const result = [];
  if (!fs.existsSync(logPath)) {
    return result;
  }
  for (const rawLine of fs.readFileSync(logPath, "utf8").split(/\r?\n/)) {
    if (!rawLine.trim()) {
      continue;
    }
    try {
      const entry = JSON.parse(rawLine);
      if ((entry.timestamp ?? "") >= startIso) {
        result.push(entry);
      }
    } catch {
      result.push({ raw: rawLine, parseError: true });
    }
  }
  return result;
}

async function wait() {
  const start = Date.now();
  for (;;) {
    const lines = readLines();
    const started = lines.some((line) => line.message === "Starting sync");
    const terminal = lines.find((line) => terminalMessages.has(line.message));
    const error = lines.find((line) => line.level === "ERROR");
    if (terminal || error) {
      fs.writeFileSync(output, JSON.stringify({
        started,
        completed: Boolean(terminal),
        terminalMessage: terminal ? terminal.message : null,
        errorMessage: error ? error.message : null,
        lines,
      }, null, 2));
      return;
    }
    if (Date.now() - start > timeoutMs) {
      fs.writeFileSync(output, JSON.stringify({
        started,
        completed: false,
        terminalMessage: null,
        errorMessage: "Timed out waiting for sync completion",
        lines,
      }, null, 2));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

wait().catch((error) => {
  fs.writeFileSync(output, JSON.stringify({
    started: false,
    completed: false,
    terminalMessage: null,
    errorMessage: String(error),
    lines: [],
  }, null, 2));
  process.exit(1);
});
NODE
}

lc_append_scenario() {
  local jsonl_path="$1"
  local id="$2"
  local status="$3"
  local summary="$4"
  local details_path="${5:-}"
  node - "$jsonl_path" "$id" "$status" "$summary" "$details_path" <<'NODE'
const fs = require("fs");
const [jsonlPath, id, status, summary, detailsPath] = process.argv.slice(2);
const entry = {
  id,
  status,
  summary,
  detailsPath: detailsPath || null,
};
fs.appendFileSync(jsonlPath, `${JSON.stringify(entry)}\n`);
NODE
}

lc_finalize_report() {
  local jsonl_path="$1"
  local output_json="$2"
  local output_md="$3"
  local mode="$4"
  local run_id="$5"
  local namespace="$6"
  local owner="$7"
  local repo="$8"
  local branch="$9"
  node - "$jsonl_path" "$output_json" "$output_md" "$mode" "$run_id" "$namespace" "$LC_VAULT_PATH" "$owner" "$repo" "$branch" <<'NODE'
const fs = require("fs");

const [
  jsonlPath,
  outputJson,
  outputMd,
  mode,
  runId,
  namespace,
  vaultPath,
  owner,
  repo,
  branch,
] = process.argv.slice(2);

const scenarios = fs.existsSync(jsonlPath)
  ? fs
      .readFileSync(jsonlPath, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  : [];

const summary = {
  pass: scenarios.filter((scenario) => scenario.status === "pass").length,
  fail: scenarios.filter((scenario) => scenario.status === "fail").length,
  skip: scenarios.filter((scenario) => scenario.status === "skip").length,
};

const report = {
  mode,
  runId,
  vaultPath,
  repo: `${owner}/${repo}`,
  branch,
  namespace,
  summary,
  scenarios,
};

fs.writeFileSync(outputJson, JSON.stringify(report, null, 2));

const lines = [
  `# ${mode} report`,
  "",
  `- Run ID: \`${runId}\``,
  `- Vault: \`${vaultPath}\``,
  `- Repo: \`${owner}/${repo}\``,
  `- Branch: \`${branch}\``,
  `- Namespace: \`${namespace}\``,
  `- Summary: ${summary.pass} passed, ${summary.fail} failed, ${summary.skip} skipped`,
  "",
  "## Scenarios",
  "",
];

for (const scenario of scenarios) {
  lines.push(`- \`${scenario.status.toUpperCase()}\` \`${scenario.id}\`: ${scenario.summary}`);
  if (scenario.detailsPath) {
    lines.push(`  Artifacts: \`${scenario.detailsPath}\``);
  }
}

fs.writeFileSync(outputMd, `${lines.join("\n")}\n`);
NODE
}

lc_safe_remove_local_namespace() {
  local namespace="$1"
  local target="$LC_VAULT_PATH/$namespace"
  case "$namespace" in
    *"__sync-"* ) ;;
    * ) lc_die "Refusing to remove non-test namespace: $namespace" ;;
  esac
  rm -rf "$target"
}

lc_prune_local_manifest_namespace() {
  local namespace="$1"
  node - "$LC_MANIFEST_PATH" "$namespace" <<'NODE'
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
}

lc_apply_remote_mutation() {
  local owner="$1"
  local repo="$2"
  local branch="$3"
  local message="$4"
  local payload_path="$5"
  node - "$owner" "$repo" "$branch" "$message" "$payload_path" <<'NODE'
const fs = require("fs");
const { execFileSync } = require("child_process");

const [owner, repo, branch, message, payloadPath] = process.argv.slice(2);
const payload = JSON.parse(fs.readFileSync(payloadPath, "utf8"));

function gh(args, input) {
  return execFileSync("gh", args, {
    input: input ? JSON.stringify(input) : undefined,
    encoding: "utf8",
  });
}

function api(path) {
  return JSON.parse(gh(["api", path]));
}

const ref = api(`repos/${owner}/${repo}/git/ref/heads/${branch}`);
const headSha = ref.object.sha;
const commit = api(`repos/${owner}/${repo}/git/commits/${headSha}`);
const baseTree = commit.tree.sha;
const tree = [];

for (const upsert of payload.upserts ?? []) {
  tree.push({
    path: upsert.path,
    mode: "100644",
    type: "blob",
    content: upsert.content,
  });
}

for (const deletion of payload.deletes ?? []) {
  tree.push({
    path: deletion,
    mode: "100644",
    type: "blob",
    sha: null,
  });
}

if (Object.prototype.hasOwnProperty.call(payload, "manifest")) {
  tree.push({
    path: ".obsidian/github-sync-metadata.json",
    mode: "100644",
    type: "blob",
    content: JSON.stringify(payload.manifest, null, 2),
  });
}

if (tree.length === 0) {
  process.exit(0);
}

const createdTree = JSON.parse(
  gh(["api", `repos/${owner}/${repo}/git/trees`, "--method", "POST", "--input", "-"], {
    base_tree: baseTree,
    tree,
  }),
);

const createdCommit = JSON.parse(
  gh(["api", `repos/${owner}/${repo}/git/commits`, "--method", "POST", "--input", "-"], {
    message,
    tree: createdTree.sha,
    parents: [headSha],
  }),
);

gh(
  ["api", `repos/${owner}/${repo}/git/refs/heads/${branch}`, "--method", "PATCH", "--input", "-"],
  { sha: createdCommit.sha },
);
NODE
}
