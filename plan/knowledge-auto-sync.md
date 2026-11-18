# Knowledge auto-sync on docs publish

Status: implemented and verified on `main` in both repos (2026-11-18).
Repos: `rallya-docs-agent` (Phase A), `rallya-docs` (Phase B)
Scope: wire the existing Sanity → Knowledge sync to run after a successful docs
publish. No changes to the agent's prompts, tools, or runtime behaviour.

## Goal

When `rallya-docs` publishes content to Sanity, the docs agent's Knowledge is
updated automatically. Only pages whose content actually changed are rewritten;
deleted docs are pruned. Nothing re-uploads the whole corpus.

## What already exists

- `scripts/sync-sanity.ts` pulls every `docPage` from Sanity and calls
  `syncSanityDocs()`.
- `upsertPage()` skips pages whose body is unchanged (`unchanged` status), so a
  re-run does not rewrite or re-embed untouched pages.
- `--remove` prunes Knowledge pages that no longer exist in Sanity; deletes are
  scoped to `author: "sync:sanity"`.
- The sync is **host-only** by design: `upsertPage()` bypasses run scopes and
  must never be exposed through an unauthenticated route.
- `rallya-docs` already syncs `content/docs` into Sanity on merge to `main` and
  triggers the production deploy (`.github/workflows/docs-sync.yml`).

## Gap

Nothing tells the agent to sync after a publish. The agent runs on the Mastra
Platform (`mastra deploy`), not on a host with the repo checked out, so no local
process can run `bun run sync`.

## Confirmed decisions

| Question | Decision |
| --- | --- |
| Trigger | `repository_dispatch` from `rallya-docs` → GitHub Actions in the agent repo |
| Update scope | Content-hash incremental: run the existing sync, `upsertPage()` writes only changed pages |
| Deleted pages | `--remove` prunes automatically |
| Failure policy | Dispatch runs after the deploy hook; a failure shows red but the site has already deployed |

## Target flow

```
merge to main (rallya-docs)
  → docs workflow: --check → sync Sanity (--prune) → trigger Vercel deploy
  → repository_dispatch(event: docs-published)      (only when docs changed)
      → rallya-docs-agent workflow on main
          → bun run scripts/sync-sanity.ts --remove
              → upsert changed pages, prune deleted ones
```

## Phase A — `rallya-docs-agent`

Do this first: `repository_dispatch` only triggers workflows that exist on the
repo's default branch.

1. Branch from `main` as `feat/knowledge-auto-sync`.
   - Note: the current working tree has uncommitted `package.json` / `bun.lock`
     changes. Commit or stash them before branching.
2. Add `.github/workflows/sync-knowledge.yml`:
   - `on: repository_dispatch: types: [docs-published]` and `workflow_dispatch`
   - `concurrency: { group: knowledge-sync, cancel-in-progress: false }`
   - `timeout-minutes: 10`
   - steps: checkout → `oven-sh/setup-bun@v2` (1.4.4) →
     `bun install --frozen-lockfile` → `bun run scripts/sync-sanity.ts --remove`
   - env: `DATABASE_URL`, `SANITY_API_READ_TOKEN`,
     `DOCS_BASE_URL=https://rallya-docs.vercel.app`
   - leave `KNOWLEDGE_SCOPE` at its `docs:rallya` default unless production
     overrides it.
3. Add repository secrets in `nikhea/rallya-docs-agent`:
   - `DATABASE_URL` — Neon production (project `mute-sky-16638432`), pooled
     connection string.
   - `SANITY_API_READ_TOKEN` — the same token used by `rallya-docs`.
4. Verify Neon accepts connections from GitHub runners (IP allowlist). If it
   does not, allowlist the runner or fall back to an authenticated endpoint on
   the agent.
5. Update `README.md` with an "Automatic re-sync" section.
6. Merge to `main`, then run the workflow once via `workflow_dispatch`.
   - Expected: `0 created, 0 updated, 22 unchanged` — 21 doc pages plus the
     sections page in the `docs:rallya` Knowledge scope (Sanity itself holds 24
     documents: 21 pages + 3 sections). This proves idempotence and DB
     connectivity before anything depends on it.

## Phase B — `rallya-docs`

1. Branch from `main` as `feat/docs-agent-dispatch`.
2. Add a change signal to `scripts/sync-docs-to-sanity.mjs`:
   - when `GITHUB_OUTPUT` is set, append `docs_changed=<writes + deletions>`.
   - `--check` and `--dry-run` keep their current behaviour.
3. Extend `.github/workflows/docs-sync.yml`:
   - give the sync step `id: sync`
   - after `Trigger production deploy`, add a dispatch step:

   ```yaml
   - name: Notify docs agent
     if: steps.sync.outputs.docs_changed != '0'
     env:
       DOCS_AGENT_DISPATCH_TOKEN: ${{ secrets.DOCS_AGENT_DISPATCH_TOKEN }}
     run: |
       curl -fsS --retry 3 --retry-all-errors -X POST \
         https://api.github.com/repos/nikhea/rallya-docs-agent/dispatches \
         -H "Authorization: Bearer $DOCS_AGENT_DISPATCH_TOKEN" \
         -H "Accept: application/vnd.github+json" \
         -d "{\"event_type\":\"docs-published\",\"client_payload\":{\"commit\":\"$GITHUB_SHA\"}}"
   ```

   - no `continue-on-error`: the deploy hook has already run, so a knowledge
     failure is visible without blocking the site.
4. Add secret `DOCS_AGENT_DISPATCH_TOKEN` in `nikhea/rallya-docs`:
   - fine-grained PAT, scoped to `rallya-docs-agent`, Contents: read/write.
5. Update `README.md`:
   - add the dispatch step and the new secret to the publishing runbook.

## Verification

Local checks (run 2026-11-18, all passed):

1. `GITHUB_OUTPUT=/tmp/out bun scripts/sync-docs-to-sanity.mjs --check` → no output file written.
2. `GITHUB_OUTPUT=/tmp/out bun scripts/sync-docs-to-sanity.mjs --dry-run` →
   `0 to write, 24 unchanged, 0 to delete`, no output file written.
3. `GITHUB_OUTPUT=/tmp/out bun scripts/sync-docs-to-sanity.mjs --prune` →
   `Nothing to do.`, output file contains `docs_changed=0`.
4. `bunx eslint scripts/sync-docs-to-sanity.mjs` → exit 0.
5. Both workflows parse as YAML; `Notify docs agent` is the last step and is
   guarded by `steps.sync.outputs.docs_changed != '0'`.
6. Agent sync against a local Postgres: `Sanity returned 21 page(s) and 3
   section(s).`, `Synced: 0 created, 0 updated, 22 unchanged.` — confirms the
   Sanity read token and idempotence.

Production checks (2026-11-18, all passed):

1. Manual run `44337484560` was the one-time catch-up of the stale production
   Knowledge: `0 created, 21 updated, 1 unchanged`. Run `44337782246` then
   confirmed idempotence: `0 created, 0 updated, 22 unchanged`.
2. Added a marker to `content/docs/llms-txt.mdx` (PR `rallya-docs#9`). Docs run
   `44338352224` reported `1 to write, 23 unchanged, 0 to delete`, the
   `Notify docs agent` step ran, and agent run `44338449378` (via
   `repository_dispatch`) reported `0 created, 1 updated, 21 unchanged`.
3. Added then removed a temporary page (PRs `rallya-docs#10` / `#11`). Docs run
   `44339743334` reported `1 to write, 23 unchanged, 1 to delete` and
   `delete: docPage.sync-smoke-test`; agent run `44339827722` logged
   `removed docs:rallya#sync-smoke-test`.
4. `POST https://rallya-docs.server.mastra.cloud/docs-chat` with a question
   about the marker returned `BLUEBERRY-7` (trace
   `5453850e20c4a7ea963b139de10146d3`), proving the deployed assistant reads
   the freshly synced Knowledge.

All smoke-test content was reverted in `rallya-docs#11`; both repos are back to
the original 21 docs pages + 3 sections.

## Notes and risks

- Code-only pushes to `main` still deploy but do not dispatch the agent
  (`docs_changed == 0`), avoiding wasted runner minutes.
- Pruning only removes pages written by `sync:sanity`; hand-authored Knowledge
  pages are untouched.
- The dispatch PAT is the only cross-repo credential. Store it as a secret and
  rotate it if needed. GitHub has no CLI/API for creating a fine-grained PAT, so
  `DOCS_AGENT_DISPATCH_TOKEN` is currently the existing `gh` OAuth token
  (`repo`, `read:org`, `gist` scopes). It works, but it is broader than the
  intended Contents-only scope on `rallya-docs-agent`; replace it with a
  fine-grained PAT at the next rotation.
- If the agent repo is private, one short Actions run is billed per docs change.
- The dispatch event must be sent to the default branch; merging Phase A before
  Phase B is required.
- No embeddings are active today (semantic search is commented out), so a
  changed page costs one page write. The same skip logic will avoid re-embedding
  unchanged pages if vectors are enabled later.
