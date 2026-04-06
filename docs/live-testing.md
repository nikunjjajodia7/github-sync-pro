# Live Testing

This repository uses a **hybrid sync validation strategy**.

## Why the hybrid split exists

The plugin syncs the entire vault and entire manifest, not just a test folder.

That means a live run in a real vault is inherently noisy when the vault already has:

- unrelated dirty files
- unrelated tracked folders
- unrelated remote manifest drift

So the test system is split into two tiers:

1. **Isolated live matrix**
   - disposable vault
   - isolated GitHub branch
   - deterministic semantic assertions

2. **Real-vault smoke**
   - actual user vault
   - namespace-scoped assertions only
   - proves runtime parity and installation correctness

## Scripts

### `scripts/live-matrix-isolated.sh`

Release-grade semantic acceptance.

Inputs:

- `--vault-path`
- `--owner`
- `--repo`
- `--branch`
- optional `--vault-id`
- optional `--timeout-seconds`

Expected environment:

- the vault is already configured to the same `owner/repo/branch`
- `obsidian-advanced-uri` is installed and enabled in that vault
- the target branch is isolated and starts **without** `.obsidian/github-sync-metadata.json`

What it validates:

- isolated bootstrap on a branch with no remote manifest
- local create / remote upload
- local delete / remote delete
- remote create / local download
- remote delete / local delete
- empty-folder create / rename / delete
- no-op sync does not advance branch head
- folder-with-files delete propagation
- adoption of local paths missing from metadata
- legacy `deletedFolders` compatibility

Output:

- `.context/live-sync-runs/<run-id>/report.json`
- `.context/live-sync-runs/<run-id>/report.md`

### `scripts/live-smoke-real-vault.sh`

Non-destructive real-vault smoke validation.

Inputs:

- `--vault-path`
- optional `--namespace-root` default: `Other Research/__sync-smoke__`
- optional `--vault-id`
- optional `--timeout-seconds`

Expected environment:

- the real vault is already configured for sync
- `obsidian-advanced-uri` is enabled
- the operator understands that the whole vault still participates in sync, even though assertions are namespace-scoped

What it validates:

- single active plugin install
- sync command starts and reaches a terminal state
- namespaced empty-folder adoption
- namespaced fresh-note upload clears dirty state
- no-op smoke rerun completes without namespace-scoped errors
- smoke namespace cleanup removes live namespace state

Important constraint:

- do **not** use branch-head stability as a required assertion in the real vault
- real-vault assertions are namespace-scoped only

Output:

- `.context/live-sync-runs/<run-id>/real-vault-smoke.json`
- `.context/live-sync-runs/<run-id>/real-vault-smoke.md`

### `scripts/live-cleanup-isolated.sh`

Cleanup helper for the isolated branch/vault test namespace.

Inputs:

- `--vault-path`
- `--owner`
- `--repo`
- `--branch`
- `--namespace`

What it does:

- removes the namespace from the local disposable vault
- prunes namespace entries from the local manifest
- removes namespace blobs from the isolated remote branch
- prunes namespace entries from the remote manifest

## Reports and artifacts

Each run writes into:

- `.context/live-sync-runs/<run-id>/`

Artifacts include:

- settings summary
- plugin runtime duplicate-check report
- local manifest subset for the namespace
- remote manifest subset for the namespace
- remote tree subset for the namespace
- filtered log lines
- per-scenario pass/fail status

## Release gate

A release is ready only if all of these pass:

1. `npm test`
2. `npm run build`
3. isolated live matrix
4. real-vault smoke suite

## Legacy scripts

These older scripts are still present for reference but are **not** the release gate anymore:

- [`src/__tests__/integration-test.sh`](/Users/nikunjjajodia/conductor/workspaces/github-sync-pro/manama/src/__tests__/integration-test.sh)
- [`src/__tests__/integration-risk-tests.sh`](/Users/nikunjjajodia/conductor/workspaces/github-sync-pro/manama/src/__tests__/integration-risk-tests.sh)

They target the real vault directly and are too noisy to serve as deterministic acceptance tests.
