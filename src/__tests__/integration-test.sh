#!/bin/bash
# LEGACY: kept for reference only.
# The primary release gate now lives in scripts/live-matrix-isolated.sh and
# scripts/live-smoke-real-vault.sh, which separate deterministic isolated
# semantics from namespace-scoped real-vault smoke checks.
# This older script targets the real vault directly and is too noisy to use as
# the primary decision gate.

set -e

VAULT="/Users/nikunjjajodia/Documents/Obsidian"
TEST_DIR="Other Research/__sync-integration-test__"
MANIFEST="$VAULT/.obsidian/github-sync-metadata.json"
DATA="$VAULT/.obsidian/plugins/github-gitless-sync-enhanced/data.json"
TOKEN=$(python3 -c "import json; print(json.load(open('$DATA'))['githubToken'])")
OWNER="nikunjjajodia7"
REPO="obsidian-vault"
BRANCH="main"
API="https://api.github.com/repos/$OWNER/$REPO"

PASS=0
FAIL=0
TESTS=()

log() { echo "  $1"; }
pass() { echo "  ✅ $1"; PASS=$((PASS + 1)); TESTS+=("PASS: $1"); }
fail() { echo "  ❌ $1"; FAIL=$((FAIL + 1)); TESTS+=("FAIL: $1"); }

gh_api() {
  curl -s -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" "$@"
}

manifest_get() {
  python3 -c "
import json
with open('$MANIFEST') as f:
    data = json.load(f)
entry = data.get('files', {}).get('$1', {})
print(json.dumps(entry))
"
}

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  SYNC ENGINE INTEGRATION TESTS"
echo "  Vault: $VAULT"
echo "  Remote: $OWNER/$REPO ($BRANCH)"
echo "  Test dir: $TEST_DIR/"
echo "═══════════════════════════════════════════════════════════"

# ─── BASELINE STATE ───
echo ""
echo "📊 BASELINE STATE"
REMOTE_FILES=$(gh_api "$API/git/trees/$BRANCH?recursive=1" | python3 -c "
import json,sys
data=json.load(sys.stdin)
blobs=[f for f in data.get('tree',[]) if f['type']=='blob']
print(len(blobs))
")
LOCAL_FILES=$(python3 -c "
import json
with open('$MANIFEST') as f:
    data=json.load(f)
print(len([k for k,v in data['files'].items() if not v.get('deleted')]))
")
log "Remote files: $REMOTE_FILES"
log "Local tracked (non-deleted): $LOCAL_FILES"

# ─── TEST 1: Create local file → check manifest ───
echo ""
echo "━━━ TEST 1: Create local file → manifest tracking ━━━"
TEST_FILE="$TEST_DIR/test-file-1.md"
echo "# Test File 1
Created at $(date) for integration testing.
This file tests local creation tracking." > "$VAULT/$TEST_FILE"

sleep 1  # Give Obsidian event listener time

ENTRY=$(manifest_get "$TEST_FILE")
if echo "$ENTRY" | python3 -c "import json,sys; d=json.load(sys.stdin); exit(0 if d else 1)" 2>/dev/null; then
  SHA=$(echo "$ENTRY" | python3 -c "import json,sys; print(json.load(sys.stdin).get('sha','NONE'))")
  DIRTY=$(echo "$ENTRY" | python3 -c "import json,sys; print(json.load(sys.stdin).get('dirty',False))")
  JD=$(echo "$ENTRY" | python3 -c "import json,sys; print(json.load(sys.stdin).get('justDownloaded',False))")
  log "Manifest entry found: sha=$SHA, dirty=$DIRTY, justDownloaded=$JD"
  if [ "$DIRTY" = "True" ]; then
    pass "Local file creation tracked as dirty in manifest"
  else
    fail "Local file should be dirty after creation, got dirty=$DIRTY"
  fi
else
  log "No manifest entry found — Obsidian may not be running or events delayed"
  fail "Local file not tracked in manifest (is Obsidian running?)"
fi

# ─── TEST 2: Check if file exists on remote (should NOT) ───
echo ""
echo "━━━ TEST 2: New local file NOT on remote yet ━━━"
REMOTE_CHECK=$(gh_api "$API/git/trees/$BRANCH?recursive=1" | python3 -c "
import json,sys
data=json.load(sys.stdin)
found=[f for f in data.get('tree',[]) if f['path']=='$TEST_FILE']
print('FOUND' if found else 'NOT_FOUND')
")
if [ "$REMOTE_CHECK" = "NOT_FOUND" ]; then
  pass "New local file correctly not on remote before sync"
else
  fail "File unexpectedly found on remote before sync"
fi

# ─── TEST 3: Create a second file locally ───
echo ""
echo "━━━ TEST 3: Create multiple local files ━━━"
TEST_FILE_2="$TEST_DIR/test-file-2.md"
TEST_FILE_3="$TEST_DIR/test-subfolder/test-nested.md"
mkdir -p "$VAULT/$TEST_DIR/test-subfolder"
echo "# Test File 2 — for batch testing" > "$VAULT/$TEST_FILE_2"
echo "# Nested Test — subfolder creation" > "$VAULT/$TEST_DIR/test-subfolder/test-nested.md"
sleep 1

ENTRY2=$(manifest_get "$TEST_FILE_2")
ENTRY3=$(manifest_get "$TEST_DIR/test-subfolder/test-nested.md")
HAS_2=$(echo "$ENTRY2" | python3 -c "import json,sys; d=json.load(sys.stdin); print('YES' if d else 'NO')" 2>/dev/null || echo "NO")
HAS_3=$(echo "$ENTRY3" | python3 -c "import json,sys; d=json.load(sys.stdin); print('YES' if d else 'NO')" 2>/dev/null || echo "NO")
if [ "$HAS_2" = "YES" ] && [ "$HAS_3" = "YES" ]; then
  pass "Multiple file creations tracked (flat + nested)"
else
  fail "Not all files tracked: file2=$HAS_2, nested=$HAS_3"
fi

# ─── TEST 4: Modify a local file → check dirty flag ───
echo ""
echo "━━━ TEST 4: Modify local file → dirty flag ━━━"
echo "
## Updated content
Added at $(date)" >> "$VAULT/$TEST_FILE"
sleep 1

ENTRY_MOD=$(manifest_get "$TEST_FILE")
DIRTY_MOD=$(echo "$ENTRY_MOD" | python3 -c "import json,sys; print(json.load(sys.stdin).get('dirty',False))" 2>/dev/null)
if [ "$DIRTY_MOD" = "True" ]; then
  pass "Modified file correctly marked dirty"
else
  fail "Modified file should be dirty, got $DIRTY_MOD"
fi

# ─── TEST 5: Delete a local file → check deleted flag ───
echo ""
echo "━━━ TEST 5: Delete local file → deleted flag ━━━"
rm "$VAULT/$TEST_FILE_2"
sleep 1

ENTRY_DEL=$(manifest_get "$TEST_FILE_2")
DELETED=$(echo "$ENTRY_DEL" | python3 -c "import json,sys; print(json.load(sys.stdin).get('deleted',False))" 2>/dev/null)
DELETED_AT=$(echo "$ENTRY_DEL" | python3 -c "import json,sys; print(json.load(sys.stdin).get('deletedAt','NONE'))" 2>/dev/null)
if [ "$DELETED" = "True" ] && [ "$DELETED_AT" != "NONE" ]; then
  pass "Deleted file correctly marked deleted with timestamp"
  log "deletedAt=$DELETED_AT"
else
  fail "Deleted file not properly tracked: deleted=$DELETED, deletedAt=$DELETED_AT"
fi

# ─── TEST 6: Push a file to remote via API → check remote state ───
echo ""
echo "━━━ TEST 6: Push test file to remote via GitHub API ━━━"
REMOTE_TEST_FILE="$TEST_DIR/remote-created.md"
CONTENT=$(echo "# Remote Created File
Created via API at $(date)
This tests download path." | base64)

# Get current HEAD
HEAD_SHA=$(gh_api "$API/git/refs/heads/$BRANCH" | python3 -c "import json,sys; print(json.load(sys.stdin)['object']['sha'])")
log "Current HEAD: $HEAD_SHA"

# Get current tree
TREE_SHA=$(gh_api "$API/git/commits/$HEAD_SHA" | python3 -c "import json,sys; print(json.load(sys.stdin)['tree']['sha'])")

# Create blob
BLOB_SHA=$(gh_api -X POST "$API/git/blobs" -d "{\"content\":\"$CONTENT\",\"encoding\":\"base64\"}" | python3 -c "import json,sys; print(json.load(sys.stdin)['sha'])")
log "Created blob: $BLOB_SHA"

# Create tree with new file
NEW_TREE_SHA=$(gh_api -X POST "$API/git/trees" -d "{
  \"base_tree\":\"$TREE_SHA\",
  \"tree\":[{\"path\":\"$REMOTE_TEST_FILE\",\"mode\":\"100644\",\"type\":\"blob\",\"sha\":\"$BLOB_SHA\"}]
}" | python3 -c "import json,sys; print(json.load(sys.stdin)['sha'])")
log "Created tree: $NEW_TREE_SHA"

# Create commit
COMMIT_SHA=$(gh_api -X POST "$API/git/commits" -d "{
  \"message\":\"[sync-test] Add remote test file\",
  \"tree\":\"$NEW_TREE_SHA\",
  \"parents\":[\"$HEAD_SHA\"]
}" | python3 -c "import json,sys; print(json.load(sys.stdin)['sha'])")
log "Created commit: $COMMIT_SHA"

# Update branch ref
gh_api -X PATCH "$API/git/refs/heads/$BRANCH" -d "{\"sha\":\"$COMMIT_SHA\"}" > /dev/null

# Verify file is on remote
VERIFY=$(gh_api "$API/git/trees/$BRANCH?recursive=1" | python3 -c "
import json,sys
data=json.load(sys.stdin)
found=[f for f in data.get('tree',[]) if f['path']=='$REMOTE_TEST_FILE']
print('FOUND' if found else 'NOT_FOUND')
")
if [ "$VERIFY" = "FOUND" ]; then
  pass "File successfully pushed to remote via API"
else
  fail "File not found on remote after push"
fi

# ─── TEST 7: Check local doesn't have remote file yet ───
echo ""
echo "━━━ TEST 7: Remote-only file not on local ━━━"
if [ ! -f "$VAULT/$REMOTE_TEST_FILE" ]; then
  pass "Remote file correctly not on local disk (needs sync to download)"
else
  fail "Remote file unexpectedly found on local disk"
fi

# ─── TEST 8: Simulate what determineSyncActions would produce ───
echo ""
echo "━━━ TEST 8: Analyze what sync would do ━━━"
python3 << 'PYEOF'
import json

vault = "/Users/nikunjjajodia/Documents/Obsidian"
with open(f"{vault}/.obsidian/github-sync-metadata.json") as f:
    manifest = json.load(f)

test_dir = "Other Research/__sync-integration-test__"
test_files = {k: v for k, v in manifest.get("files", {}).items() if k.startswith(test_dir)}

print(f"  Test files in manifest: {len(test_files)}")
for path, meta in sorted(test_files.items()):
    sha = meta.get("sha", "null")
    dirty = meta.get("dirty", False)
    deleted = meta.get("deleted", False)
    jd = meta.get("justDownloaded", False)
    status = []
    if dirty: status.append("DIRTY")
    if deleted: status.append("DELETED")
    if jd: status.append("JUST_DL")
    if sha is None: status.append("NULL_SHA")
    status_str = ", ".join(status) if status else "CLEAN"
    print(f"    {path}: [{status_str}]")

# What sync would do:
print()
print("  Expected sync actions:")
for path, meta in sorted(test_files.items()):
    if meta.get("deleted"):
        print(f"    {path} → SKIP (deleted locally, not on remote)")
    elif meta.get("sha") is None and meta.get("dirty"):
        print(f"    {path} → UPLOAD (new local file, no remote SHA)")
    elif meta.get("dirty"):
        print(f"    {path} → UPLOAD (local modifications)")
    else:
        print(f"    {path} → NO ACTION")

# Remote file that's not in local manifest
print(f"    {test_dir}/remote-created.md → DOWNLOAD (remote-only, not in local metadata)")
PYEOF
pass "Sync action analysis complete"

# ─── TEST 9: Rename test ───
echo ""
echo "━━━ TEST 9: Rename file → old deleted + new created ━━━"
TEST_FILE_RENAMED="$TEST_DIR/test-file-1-renamed.md"
mv "$VAULT/$TEST_FILE" "$VAULT/$TEST_FILE_RENAMED"
sleep 1

ENTRY_OLD=$(manifest_get "$TEST_FILE")
ENTRY_NEW=$(manifest_get "$TEST_FILE_RENAMED")
OLD_DELETED=$(echo "$ENTRY_OLD" | python3 -c "import json,sys; print(json.load(sys.stdin).get('deleted',False))" 2>/dev/null)
NEW_EXISTS=$(echo "$ENTRY_NEW" | python3 -c "import json,sys; d=json.load(sys.stdin); print('YES' if d else 'NO')" 2>/dev/null || echo "NO")

if [ "$OLD_DELETED" = "True" ] && [ "$NEW_EXISTS" = "YES" ]; then
  pass "Rename correctly tracked: old=deleted, new=created"
else
  fail "Rename tracking issue: old_deleted=$OLD_DELETED, new_exists=$NEW_EXISTS"
fi

# ─── CLEANUP: Remove all test files locally ───
echo ""
echo "━━━ CLEANUP: Removing local test files ━━━"
rm -rf "$VAULT/$TEST_DIR"
sleep 1
log "Local test files removed"

# ─── CLEANUP: Remove test file from remote ───
echo ""
echo "━━━ CLEANUP: Removing test file from remote ━━━"
HEAD_SHA=$(gh_api "$API/git/refs/heads/$BRANCH" | python3 -c "import json,sys; print(json.load(sys.stdin)['object']['sha'])")
TREE_SHA=$(gh_api "$API/git/commits/$HEAD_SHA" | python3 -c "import json,sys; print(json.load(sys.stdin)['tree']['sha'])")

# Create tree with file deleted (sha=null)
CLEAN_TREE_SHA=$(gh_api -X POST "$API/git/trees" -d "{
  \"base_tree\":\"$TREE_SHA\",
  \"tree\":[{\"path\":\"$REMOTE_TEST_FILE\",\"mode\":\"100644\",\"type\":\"blob\",\"sha\":null}]
}" | python3 -c "import json,sys; print(json.load(sys.stdin)['sha'])")

CLEAN_COMMIT_SHA=$(gh_api -X POST "$API/git/commits" -d "{
  \"message\":\"[sync-test] Cleanup test files\",
  \"tree\":\"$CLEAN_TREE_SHA\",
  \"parents\":[\"$HEAD_SHA\"]
}" | python3 -c "import json,sys; print(json.load(sys.stdin)['sha'])")

gh_api -X PATCH "$API/git/refs/heads/$BRANCH" -d "{\"sha\":\"$CLEAN_COMMIT_SHA\"}" > /dev/null
log "Remote test file removed"

# ─── CLEANUP: Remove test entries from manifest ───
echo ""
echo "━━━ CLEANUP: Removing test entries from manifest ━━━"
python3 << 'PYEOF'
import json
manifest_path = "/Users/nikunjjajodia/Documents/Obsidian/.obsidian/github-sync-metadata.json"
with open(manifest_path) as f:
    data = json.load(f)

test_prefix = "Other Research/__sync-integration-test__"
removed = [k for k in data["files"] if k.startswith(test_prefix)]
for k in removed:
    del data["files"][k]

with open(manifest_path, "w") as f:
    json.dump(data, f)

print(f"  Removed {len(removed)} test entries from manifest")
PYEOF

# ─── RESULTS ───
echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  RESULTS: $PASS passed, $FAIL failed ($(($PASS + $FAIL)) total)"
echo "═══════════════════════════════════════════════════════════"
for t in "${TESTS[@]}"; do
  echo "  $t"
done
echo ""
