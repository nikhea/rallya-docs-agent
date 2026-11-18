# Docs → Sanity → Knowledge automation flow

This describes the live pipeline between `rallya-docs` and `rallya-docs-agent`.

## The pipeline at a glance

```
content/docs/*.mdx  +  meta.json          (rallya-docs repo = source of truth)
        │
        │  PR: --check
        ▼
GitHub Actions "Docs"  ──push to main──▶  publish job
        │
        ├─ 1. sync content/docs → Sanity      (only changed docs written)
        ├─ 2. POST Vercel deploy hook          (production deploy)
        └─ 3. POST repository_dispatch         (only if docs_changed != 0)
                    │
                    ▼
        rallya-docs-agent  "Knowledge sync" workflow
                    │
                    └─ bun run scripts/sync-sanity.ts --remove
                            │
                            ▼
                    Mastra Knowledge in Neon  (docs:rallya scope)
                            │
                            ▼
                    deployed agent answers /docs-chat from that Knowledge
```

## Stage 1 — validation on a pull request

`.github/workflows/docs-sync.yml` runs a `Docs` check when the PR touches docs, the sync script, Sanity config, dependencies, or the workflow itself.

It runs `bun scripts/sync-docs-to-sanity.mjs --check`, which verifies:

- frontmatter (`title`, `description`, valid icon)
- slugs and sidebar order in `meta.json`
- that every `.mdx` file is listed in `meta.json` and vice versa
- that every MDX body compiles with the same plugin preset the site build uses

This catches bad content before merge. Vercel preview builds still run, but automatic `main` builds are deliberately disabled.

## Stage 2 — publish to Sanity on merge

When `main` is pushed, the `publish` job runs the same script with `--prune`:

1. It reads all docs and sections and computes a SHA-256 `bodyHash` for each.
2. It queries Sanity for existing documents stamped `managedBy: "repo"`.
3. It compares hashes:
   - same hash → skipped (`unchanged`)
   - different hash → `create` or `update`
   - document in Sanity but no longer in the repo → `delete` (only if `--prune`)
4. It writes a transaction and prints the summary, e.g. `1 to write, 23 unchanged, 1 to delete`.
5. It appends `docs_changed=<writes + deletions>` to `GITHUB_OUTPUT`. `--check` and `--dry-run` never write this output.

Sanity is a **publish target**, not the source of truth. Every repo-managed document carries `managedBy: "repo"` and `bodyHash`; Studio edits to those pages are overwritten on the next push. Studio-created pages are never touched.

## Stage 3 — deploy the site

Next step: `curl -X POST "$VERCEL_DEPLOY_HOOK_URL"`.

This is the only thing that deploys production. Vercel's Ignored Build Step is set to:

```sh
if [ "$VERCEL_GIT_COMMIT_REF" = "main" ]; then exit 1; else exit 0; fi
```

That prevents an automatic `main` build from racing the Sanity sync. Sanity is updated first, so the rebuilt site and `/llms.txt` always render the content that was just merged.

## Stage 4 — notify the agent

Last step in the docs workflow:

```yaml
- name: Notify docs agent
  if: steps.sync.outputs.docs_changed != '0'
```

It POSTs a `repository_dispatch` event `docs-published` to `nikhea/rallya-docs-agent`, with the source commit in `client_payload`.

- A code-only push publishes nothing (`docs_changed=0`), so the step is skipped and no runner minutes are spent.
- There is no `continue-on-error`: if the dispatch fails, the run goes red — but it happens after the deploy hook, so the public site is already deploying.
- `repository_dispatch` only triggers workflows that exist on the agent repo's **default branch**, which is why the agent workflow had to merge first.

## Stage 5 — incremental Knowledge sync in the agent

`.github/workflows/sync-knowledge.yml` runs on that dispatch (and can also be triggered manually). It checks out the repo, installs Bun dependencies, checks that `DATABASE_URL` and `SANITY_API_READ_TOKEN` are present, then runs:

```bash
bun run scripts/sync-sanity.ts --remove
```

The script:

1. Fetches all `docPage` / `docSection` documents from Sanity via GROQ (21 pages + 3 sections today).
2. Turns each page into a Knowledge page under `docs:rallya#<slug>` with its title, description, MDX body, and a link back to the live docs URL. Sections become `docs:rallya#docs-structure`.
3. Calls `upsertPage()` for each. **This is the key incremental part:** `upsertPage()` compares the body, reports `unchanged` when it matches, and does not rewrite or re-embed that page. Only genuinely changed pages are written.
4. With `--remove`, walks the `docs:rallya` scope tree and deletes Knowledge pages whose docs no longer exist in Sanity — but only ones authored by `sync:sanity`. Hand-authored Knowledge pages are never deleted.

A healthy run looks like `0 created, 0 updated, 22 unchanged`. After a one-page edit: `0 created, 1 updated, 21 unchanged`. After a deletion: `removed docs:rallya#<slug>`.

The agent reads this shared Knowledge through its read-only tools (`knowledge_search`, `knowledge_list`, `knowledge_read`), so `/docs-chat` answers reflect the new content without redeploying the agent itself.

## Credentials

| Repo | Secret | Purpose |
| --- | --- | --- |
| `rallya-docs` | `SANITY_API_WRITE_TOKEN` | write docs into Sanity |
| `rallya-docs` | `VERCEL_DEPLOY_HOOK_URL` | trigger production deploy |
| `rallya-docs` | `DOCS_AGENT_DISPATCH_TOKEN` | send `repository_dispatch` cross-repo |
| `rallya-docs-agent` | `DATABASE_URL` | Neon Postgres holding Knowledge + memory |
| `rallya-docs-agent` | `SANITY_API_READ_TOKEN` | read the private Sanity dataset |

## Why it doesn't re-upload everything

Two independent content checks do the work:

- `bodyHash` in Sanity makes the repo → Sanity step write only changed documents.
- `upsertPage()`'s body comparison makes the Sanity → Knowledge step write only changed pages.

Each stage scans the small corpus (24 documents) but writes almost nothing on a normal publish.

## Where to watch it

- `gh run list --repo nikhea/rallya-docs`
- `gh run list --repo nikhea/rallya-docs-agent`
- Sanity Studio → `docPage` / `docSection` documents
- Mastra Studio → Knowledge → `docs:rallya`
- Related docs in this repo: `plan/knowledge-auto-sync.md` and `plan/knowledge-sync-runbook.md`
