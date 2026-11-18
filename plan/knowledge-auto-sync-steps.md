# Knowledge auto-sync — 10-step commit plan

Branches: `feat/knowledge-auto-sync` in `rallya-docs-agent` (steps 1–5),
`feat/docs-agent-dispatch` in `rallya-docs` (steps 6–10)
Companion: `plan/knowledge-auto-sync.md`
Rule: one commit per step, each independently reviewable and green. No code in
this document — it is the implementation checklist.

Progress: not started.

Order matters: `repository_dispatch` only triggers workflows that exist on the
agent repo's default branch, so steps 1–5 must merge to `main` before step 8 can
fire successfully.

---

## 1. `docs(plan): knowledge auto-sync plan and step breakdown`

**Repo:** `rallya-docs-agent`

**Files**
- `plan/knowledge-auto-sync.md`
- `plan/knowledge-auto-sync-steps.md`

**Work**
- Commit the two plan documents only.

**Done when**
- `git status` clean after the commit; no code or workflow touched.

---

## 2. `feat(ci): add the knowledge sync workflow`

**Repo:** `rallya-docs-agent`

**Files**
- `.github/workflows/sync-knowledge.yml` (new)

**Work**
- Triggers: `repository_dispatch: types: [docs-published]` and
  `workflow_dispatch`.
- `concurrency: { group: knowledge-sync, cancel-in-progress: false }` so two
  publishes cannot interleave writes.
- `timeout-minutes: 10`.
- `permissions: contents: read`.
- Job `sync` on `ubuntu-latest` with env `DATABASE_URL`,
  `SANITY_API_READ_TOKEN`, `DOCS_BASE_URL=https://rallya-docs.vercel.app`.
- Steps: `actions/checkout@v4` → `oven-sh/setup-bun@v2` (bun `1.4.4`) →
  `bun install --frozen-lockfile` → `bun run scripts/sync-sanity.ts --remove`.

**Verify**
- `actionlint .github/workflows/sync-knowledge.yml` (or a YAML parse) passes.
- `bun run scripts/sync-sanity.ts --dry-run` still works locally.
- The workflow appears under Actions with a "Run workflow" button.

**Done when**
- Workflow file is the only change; the script itself is untouched.

---

## 3. `feat(ci): fail fast when sync secrets are missing`

**Repo:** `rallya-docs-agent`

**Files**
- `.github/workflows/sync-knowledge.yml`

**Work**
- Add a preflight step before the sync that exits non-zero with
  `::error::DATABASE_URL is not configured` / `::error::SANITY_API_READ_TOKEN is
  not configured` when either env var is empty.
- Mirror the shape of the existing docs workflow's "Check required secrets" step.

**Verify**
- Temporarily unset a value in a local `act`/dry parse (or reason it through):
  the step fails before any network call.
- With both set, the step passes with no output.

**Done when**
- A missing secret produces one clear annotation, not a deep connection error.

---

## 4. `docs(readme): document automatic knowledge re-sync`

**Repo:** `rallya-docs-agent`

**Files**
- `README.md`

**Work**
- Add an "Automatic re-sync" subsection near the existing "Re-syncing" section.
- State the trigger (`repository_dispatch: docs-published` from `rallya-docs`),
  what the run does (`--remove`, incremental via unchanged-body skip), and that
  unchanged pages are never rewritten or re-embedded.
- Point at the workflow file and the two required repository secrets.

**Verify**
- Headings still render in order; no broken relative links.

**Done when**
- A reader can explain the trigger without opening the workflow.

---

## 5. `docs(runbook): knowledge sync operations runbook`

**Repo:** `rallya-docs-agent`

**Files**
- `plan/knowledge-sync-runbook.md` (new)

**Work**
- Record the operational facts:
  - Secrets and where they come from (`DATABASE_URL` from Neon project
    `mute-sky-16638432`, `SANITY_API_READ_TOKEN` shared with `rallya-docs`).
  - How to check Neon accepts GitHub runner IPs; what to do if it does not.
  - Manual re-run via `workflow_dispatch` and the expected no-op line
    (`0 created, 0 updated, 24 unchanged`).
  - How to read a run: `created` / `updated` / `unchanged` / `removed` lines.
  - Rollback: re-run the sync; pruning is limited to `author: "sync:sanity"`.
  - Failure semantics: red run after the site deploy; safe to re-run.

**Verify**
- Every command in the runbook is copy-pasteable and uses real paths.

**Done when**
- No step requires reading the source to complete.

---

## 6. `feat(scripts): emit docs_changed for the workflow`

**Repo:** `rallya-docs`

**Files**
- `scripts/sync-docs-to-sanity.mjs`

**Work**
- Track the number of writes plus deletions during a publish run.
- When `process.env.GITHUB_OUTPUT` is set, append
  `docs_changed=<count>` to that file (append, never overwrite, since other steps
  may write there too).
- `--check` and `--dry-run` keep their current behaviour and never report a
  change count as if it were applied.

**Verify**
- `GITHUB_OUTPUT=/tmp/out bun scripts/sync-docs-to-sanity.mjs --prune` writes one
  `docs_changed=` line when content changed and `docs_changed=0` on a no-op run.
- `--check` output is unchanged.

**Done when**
- A second identical run reports `docs_changed=0`.

---

## 7. `refactor(ci): give the docs sync step an id`

**Repo:** `rallya-docs`

**Files**
- `.github/workflows/docs-sync.yml`

**Work**
- Add `id: sync` to the "Sync content/docs into Sanity" step so later steps can
  read `steps.sync.outputs.docs_changed`.
- No other change.

**Verify**
- Workflow YAML parses; a dry run of the publish job is unchanged in behaviour.

**Done when**
- The diff is a single added line.

---

## 8. `feat(ci): dispatch the docs agent after a publish`

**Repo:** `rallya-docs`

**Files**
- `.github/workflows/docs-sync.yml`

**Work**
- After "Trigger production deploy", add "Notify docs agent":
  - `if: steps.sync.outputs.docs_changed != '0'`
  - `env: DOCS_AGENT_DISPATCH_TOKEN: ${{ secrets.DOCS_AGENT_DISPATCH_TOKEN }}`
  - `curl -fsS --retry 3 --retry-all-errors -X POST` to
    `https://api.github.com/repos/nikhea/rallya-docs-agent/dispatches` with
    `event_type: docs-published` and `client_payload.commit = $GITHUB_SHA`.
- No `continue-on-error`: the deploy hook has already run, so a knowledge failure
  is visible without blocking the site.

**Verify**
- On a code-only push (`docs_changed == 0`) the step is skipped.
- A docs change sends one dispatch; response is `204`.

**Done when**
- The docs workflow green run is followed by a `docs-published` run in the agent
  repo's Actions list.

---

## 9. `docs(readme): document the docs agent dispatch secret`

**Repo:** `rallya-docs`

**Files**
- `README.md`

**Work**
- Extend the publishing runbook: the sync → deploy → dispatch order, the
  `docs_changed` guard, and how to create `DOCS_AGENT_DISPATCH_TOKEN`
  (fine-grained PAT, `rallya-docs-agent` only, Contents: read/write).
- Note the failure policy and how to re-run.

**Verify**
- Links and secret names match the workflow exactly.

**Done when**
- The README alone is enough to reproduce the setup.

---

## 10. `docs(plan): record end-to-end verification`

**Repo:** `rallya-docs-agent` and `rallya-docs`

**Files**
- `plan/knowledge-auto-sync.md`
- `plan/knowledge-auto-sync-steps.md` (this file)

**Work**
- Run the end-to-end checks and record each result:
  1. Agent workflow manual run → `0 created, 0 updated, 24 unchanged`.
  2. Edit one page in `content/docs` → merge → docs workflow green → agent run
     reports `1 updated, 23 unchanged`.
  3. Delete one page → merge → agent log shows `removed docs:rallya#<slug>`.
  4. Ask the deployed assistant a question answered by the edited page and
     confirm the answer reflects the new content.
- Update this file's `Progress:` line and any deviation notes.

**Verify**
- All four results are quoted with the run ids or timestamps.

**Done when**
- Both plan files describe shipped behaviour, not intentions.

---

## Notes

- Steps 1–5 ship in `rallya-docs-agent`; merge them before starting step 8.
- Steps 6–10 ship in `rallya-docs` and depend on the agent workflow existing on
  `main`.
- Dashboard-only work (Neon allowlist, PAT creation, repository secrets) belongs
  to the runbook in step 5 and the verification in step 10 — never committed.
- If a step reveals the design is wrong, amend the companion plan in that step's
  commit rather than silently diverging.
