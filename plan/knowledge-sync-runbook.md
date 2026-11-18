# Knowledge sync runbook

Operational notes for `.github/workflows/sync-knowledge.yml`, the workflow that
keeps the docs agent's Knowledge in step with the Sanity docs published by
`rallya-docs`.

## What runs, and when

```
rallya-docs: merge to main
  → sync content/docs into Sanity → trigger the production deploy
  → repository_dispatch: docs-published
      → rallya-docs-agent: Knowledge sync
          → bun run scripts/sync-sanity.ts --remove
```

`rallya-docs` only dispatches when the sync wrote or deleted at least one page
(`docs_changed != 0`), so code-only pushes cost no runner minutes. If the
dispatch is lost, run the workflow by hand — the sync is idempotent.

## Secrets

Configured under **Settings > Secrets and variables > Actions** in
`nikhea/rallya-docs-agent`.

| Secret | Where it comes from |
| --- | --- |
| `DATABASE_URL` | Neon project `mute-sky-16638432` (org `org-shy-smoke-58667038`). Use the **pooled** connection string: the runner opens many short-lived connections. The database needs the `vector` extension, which the agent's `init()` enables. |
| `SANITY_API_READ_TOKEN` | The same read token `rallya-docs` uses (its `SANITY_API_READ_TOKEN`). The dataset is private, so an anonymous client cannot read it. |

`DOCS_BASE_URL` is set in the workflow, not as a secret:
`https://rallya-docs.vercel.app`.

Never print either secret. To rotate, set a new value with
`gh secret set <NAME> --repo nikhea/rallya-docs-agent` and re-run the workflow.

## Neon connectivity

Neon accepts connections from GitHub-hosted runners unless **IP Allow** is
enabled for the project. If the first run fails with a connection timeout rather
than an authentication error:

1. Open the Neon console for `mute-sky-16638432` > **Settings > Network**.
2. Either disable IP Allow, or add the GitHub Actions ranges (they change; a
   self-hosted runner with a fixed egress IP is the durable option).
3. Re-run the workflow. The secret does not need to change.

The same connection string works locally:

```bash
psql "$DATABASE_URL" -c 'select count(*) from information_schema.tables;'
```

Do not point `DATABASE_URL` at the local `localhost` database — the local file
`.env` is not used by Actions.

## Running it

From the UI: **Actions > Knowledge sync > Run workflow** on `main`.

From the CLI:

```bash
gh workflow run sync-knowledge.yml --repo nikhea/rallya-docs-agent
gh run list --repo nikhea/rallya-docs-agent --limit 5
gh run view <run-id> --repo nikhea/rallya-docs-agent --log
```

Locally, against the database in `.env`:

```bash
bun run sync -- --dry-run          # report only
bun run sync -- --remove           # apply, prune deleted pages
```

`--dry-run` never writes. Use it to confirm a token before changing a secret.

## Reading a run

The sync prints one line per page and a summary:

```
create: docPage.quickstart
update: docPage.api-keys
removed docs:rallya#old-page
created 1, updated 1, removed 1, 23 unchanged
```

- `created` / `updated` — new or changed bodies; only these are written.
- `unchanged` — body hash matched; nothing rewritten, nothing re-embedded.
- `removed` — page no longer in Sanity, authored by `sync:sanity`.

Expected baseline on an up-to-date corpus: `0 created, 0 updated, 24 unchanged`
(the count grows as docs are added).

## Failure handling

- **Missing secret** — the "Check required secrets" step fails before any
  network call and names the missing variable.
- **Sanity read failure** — wrong or revoked `SANITY_API_READ_TOKEN`, or the
  dataset name changed; fix the secret and re-run.
- **Database failure** — connection/timeout means the Neon allowlist (above);
  `password authentication failed` means a stale `DATABASE_URL`.
- **Dispatch never arrived** — `repository_dispatch` only triggers workflows
  that exist on the default branch. Merge the workflow first, then re-run by
  hand.

A failed run turns the docs workflow red *after* the site deploy has already
been triggered, so the public site is not blocked. Re-running is always safe.

## Rollback

There is no separate rollback: the sync is a mirror, so the fix is to change
`content/docs` and publish again, or to re-run the workflow.

- A page pruned by mistake reappears after its file is restored in
  `rallya-docs` and merged.
- Pruning is limited to `author: "sync:sanity"`. Pages created by hand in
  Knowledge are never deleted by `--remove`.
- `--remove --force` additionally deletes pages that still have child pages. Use
  it only when intentionally removing a branch of the tree.
- To read the current state without writing, run `bun run sync -- --dry-run`.

## Cost

One short job per docs publish: checkout, `bun install --frozen-lockfile`, and a
scan of ~24 small pages. No embeddings are active today (semantic search is
commented out), so a changed page costs one page write; if vectors are enabled
later, the same unchanged-body skip keeps unchanged pages from being re-embedded.
