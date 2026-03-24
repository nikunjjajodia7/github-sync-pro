# GitHub Sync Pro

An Obsidian plugin that syncs vaults to GitHub without requiring git.
Repo: github.com/nikunjjajodia7/github-sync-pro
Plugin ID: github-gitless-sync-enhanced
Distribution: BRAT (https://github.com/nikunjjajodia7/github-sync-pro)
GitHub App: "Sync Pro for Obsidian" — Client ID: Iv23liwq8PhSpVtHGahx
GitHub App Org: (registered under dedicated org for bus-factor protection)

## Session Management

**Start a NEW session when:**
- Switching to a different feature ("OAuth done, now version history")
- After a release is shipped
- After a revert (old context has stale file contents)
- Context feels heavy (going back and forth, mistakes or repetition)
- Switching from design to implementation (/office-hours → new session → implement)

**Stay in the SAME session when:**
- Working on one feature end-to-end (design → implement → review → ship)
- Debugging a specific bug (/investigate → fix → verify)
- Iterating on review feedback (/review → fix issues → re-review)
- Quick follow-ups on the same topic

**Each feature from the re-add list should be its own session:**
```
Session 1: /office-hours → design OAuth onboarding
Session 2: Implement OAuth (branch, TDD, /review, /ship)
Session 3: /office-hours → design version history
Session 4: Implement version history
...
```

Rule: if you're about to say "now let's do something completely different" — start a new session.

## Development Workflow — Use gstack Skills

This project uses gstack skills for the entire development lifecycle.
Follow this workflow for EVERY feature or change:

### 1. Design Phase (before writing any code)

Use `/office-hours` for new features or significant changes.
- Produces a design doc with problem statement, constraints, alternatives
- Design docs saved to `~/.gstack/projects/github-sync-pro/`
- Skip for small bug fixes — go straight to implementation

### 2. Plan Phase (before implementing)

Use `/plan-eng-review` to review the design and lock in architecture.
- Catches scope creep, over-engineering, and missing edge cases
- Especially important for anything touching the sync engine
- Creates a test plan for `/qa` to consume later

Use `/plan-ceo-review` only for major product direction changes.
Use `/plan-design-review` only for UI/UX changes (wizard, settings tab, views).

### 3. Implementation Phase

**One feature per branch. One feature per session.**

```bash
git checkout -b feature/<name>
```

- New features: create NEW files. Do not modify core sync files.
- Bug fixes: use `/investigate` for systematic root cause analysis.
  Never patch symptoms. Find the root cause first.
- Use `/freeze <dir>` to restrict edits to the relevant directory.
  Prevents accidentally modifying unrelated code.

### 4. Review Phase (before merging)

Run these in order:

1. `/review` — Pre-landing structural review. Catches SQL safety, race
   conditions, trust boundary violations, dead code. Fixes issues directly.

2. `/codex` — Independent second opinion from OpenAI. Adversarial review
   that tries to break the code. Informational, not blocking.

3. `/simplify` — Code reuse, quality, and efficiency scan. Catches DRY
   violations, unnecessary complexity, missed concurrency.

### 5. Testing Phase (before releasing)

- `npm run build` — must pass
- `npm test` — must pass (when tests exist)
- User MUST test on a TEST vault (not production notes) on BOTH:
  - Desktop (Mac/Windows)
  - Mobile (iOS/Android)
- Use `/qa` if there's a testable UI

### 6. Release Phase

Use `/ship` to create the release:
- Bumps version in manifest.json, manifest-beta.json, package.json, versions.json
- Builds production bundle
- Creates GitHub release with main.js, manifest.json, styles.css
- Users update via BRAT

### 7. Post-Release

- `/document-release` to update README and docs
- `/retro` for weekly retrospective on what shipped

### When Things Go Wrong

- **Bug report from user**: Use `/investigate` — systematic 4-phase debugging.
  Never guess. Trace the code path, form a hypothesis, verify before fixing.
- **Release is broken**: REVERT FIRST (`git revert` or reset to last known good).
  Then debug on a branch. Never patch forward on main.
- **Multiple bugs cascading**: STOP. The architecture is wrong, not the code.
  Use `/plan-eng-review` to rethink the approach.

## Sync Engine — Protected Zone

These files are the core sync engine. Bugs here cause DATA LOSS across
all user devices. They require the highest level of care.

**Core files:**
- `src/sync-manager.ts` — sync logic, conflict detection, tree commits
- `src/events-listener.ts` — file create/modify/delete/rename event handling
- `src/metadata-store.ts` — local metadata tracking (SHAs, dirty flags, deleted state)

### Rules for Core File Changes

1. **Write tests FIRST** (TDD):
   - Test proving current behavior (green)
   - Test proving desired behavior (red — fails without the change)
   - Make the change
   - Both tests pass (green)

2. **Never modify alongside new features.** If you're adding OAuth AND
   fixing a sync bug, do them in SEPARATE branches and SEPARATE sessions.

3. **Run `/review` before merging.** The review must specifically check
   the delete propagation flow, two-way sync, and cross-device behavior.

4. **Test on both desktop and mobile** before releasing. Use a test vault.

5. **If the fix touches >3 files, use `/investigate`** to verify the root
   cause before implementing. Large sync engine diffs are a red flag.

### What NOT to Do (learned the hard way)

- Do NOT add metadata fields to the manifest without considering how
  old versions on other devices will handle the new fields
- Do NOT purge deleted entries from the manifest immediately — other
  devices need time to see the `deleted=true` flag
- Do NOT add parallel tracking systems (folders, settings) that interact
  with the file sync in complex ways
- Do NOT modify `commitSync()`, `determineSyncActions()`, or `syncImpl()`
  without tests covering the exact code path being changed
- Do NOT test sync engine changes on the user's production vault

## Build & Test

```bash
npm install --force   # Install dependencies
npm run build         # TypeScript check + esbuild production bundle
npm test              # Vitest test suite
```

Always run build before committing. Always run tests if they exist.

## Architecture

```
src/
  main.ts              — Plugin entry point, commands, UI wiring
  sync-manager.ts      — CORE: sync logic, conflict detection, commit
  events-listener.ts   — CORE: file create/modify/delete/rename events
  metadata-store.ts    — CORE: local file tracking metadata
  github/client.ts     — GitHub API wrapper (requestUrl-based)
  settings/settings.ts — Settings interface and defaults
  settings/tab.ts      — Settings UI (Obsidian SettingTab)
  views/               — React views (conflict resolution)
  sync-scope.ts        — File filtering (notes-first, excluded extensions)
  utils.ts             — Shared utilities (retry, base64, clipboard)
  logger.ts            — File-based logging
```

### Sync Flow (simplified)

```
Plugin loads → loadMetadata() → start EventsListener → start sync interval

Sync cycle:
  1. getRepoContent() — fetch remote git tree
  2. Read remote manifest — fetch metadata from GitHub
  3. Reconcile: compare local metadata vs remote metadata
  4. determineSyncActions() — upload/download/delete_local/delete_remote
  5. Execute actions (upload files, download files, delete)
  6. commitSync() — create git tree + commit + push
  7. Save local metadata

Delete propagation:
  Device A deletes file → metadata: deleted=true → manifest uploaded
  Device B syncs → reads manifest → sees deleted=true → delete_local
  Deleted entries stay in manifest indefinitely (v1.1.5 behavior)
```

### Key Technical Details

- **GitHub Trees API**: `base_tree` preserves all existing files unless
  explicitly set to `sha=null`. This means orphaned files persist forever
  unless actively removed.
- **notes-first mode**: Only syncs files with extensions in NOTES_FIRST_EXTENSIONS
  (md, txt, csv, json, png, jpg, etc.). Files uploaded before this filter
  was introduced (.ts, .cjs, .DS_Store) become invisible orphans.
- **Metadata manifest**: `.obsidian/github-sync-metadata.json` is tracked
  as a regular file in the git tree. It's the source of truth for what
  files exist, their SHAs, and their sync state.

## Obsidian Plugin Environment

- HTTP: `requestUrl` from obsidian (works on mobile, no CORS issues)
- Filesystem: `vault.adapter` (read, write, readBinary, writeBinary, exists, list, mkdir, rmdir, remove)
- Events: `vault.on("create"/"modify"/"delete"/"rename")`
- Obsidian adds: `String.prototype.contains`, `Array.prototype.last`
- Device-specific: `workspace.json`, `workspace-mobile.json` — NEVER sync these
- Plugin data: `.obsidian/plugins/github-gitless-sync-enhanced/data.json`
- No native modules allowed (community plugin validation requirement)
- Must work on iOS and Android (Obsidian mobile)

## History and Lessons

### v1.1.5 — Last Stable Release (current base as v1.4.0)
- Reliable two-way sync, delete propagation, conflict detection
- notes-first scope filtering introduced
- Baseline hydration for reducing false conflicts

### v1.2.x-1.3.x — Failed Feature Sprint (reverted)
13 patch releases that broke sync. Root causes:
1. Modified sync engine alongside new features in one session
2. Tested on production vault instead of test vault
3. Patched forward instead of reverting when bugs appeared
4. No tests before modifying core sync logic
5. Folder sync via metadata layer was wrong abstraction
6. Manifest cleanup code broke cross-device delete propagation
7. Orphan sweep accidentally deleted the manifest file itself

Key regressions introduced:
- v1.1.6: `delete_remote` handler added guard that threw instead of handling
  files already absent from remote tree — broke delete propagation
- v1.2.2: Purged `deleted=true` entries from manifest immediately — broke
  cross-device delete (other device couldn't see the deletion flag)
- v1.2.6-1.2.9: Folder metadata system had race conditions, missed events,
  and re-created ghost folders from stale remote data

### Features to Re-Add (with proper TDD)
These were built in the 1.2.x series and need to be re-implemented properly:
- OAuth onboarding wizard (Device Flow, client ID: Iv23liwq8PhSpVtHGahx)
- Version history viewer (timeline, diff, restore)
- Selective sync (user-defined exclude patterns)
- Settings sync (shallow JSON merge across devices)
- diff3 auto-merge for non-overlapping conflicts
- Push-on-save (debounced sync on file modification)
- Rate limit tracking on API responses
- DRY refactor of GithubClient (request helper)

Each should be a separate feature branch with its own tests and review cycle.
