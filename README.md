# AI Company — orchestrator

A small "company" of AI agents with fixed roles and mandatory cross-checks.
No agent can mark its own work "done" — the next role always has to sign
off, and nothing ships until real verification commands (build/tests) have
actually passed.

## Roles

| Role | Agent | Does | Does NOT do |
|---|---|---|---|
| Idea lead | Gemini | Drafts the idea brief, later reviews the implementation | Write code, approve its own idea |
| Architecture lead / final sign-off | Claude | Mentors the engineer with a precise, step-by-step implementation guide (no code); on rejection, gives exact fix-it instructions; gives the final go/no-go | Write code |
| Engineer | Muse (via MCP, browser-driven) | Implements the spec in code | Review or approve its own work |
| CEO | You | Approves the idea, approves the final ship | Everything else |

## Pipeline

```
ideation (Gemini)
  -> checkpoint_idea (YOU)         -- reject sends it back to ideation
  -> architecture (Claude, spec only)
  -> implementation (Muse)
  -> verification (real commands: build/tests)   -- failure loops back to implementation
  -> review_gemini                                -- reject loops back to implementation
  -> review_claude                                -- reject loops back to implementation
  -> checkpoint_final (YOU)        -- reject sends it back through ideation (a redesign, not a quick fix)
  -> done
```

If Gemini's own retry budget is exhausted (its free tier is down for a
stretch — rate limited or overloaded), Claude stands in for just that
round's `review_gemini` rather than leaving the task stuck: logged clearly
as a stand-in, not a permanent reassignment. The next round tries Gemini
again.

`done` is reachable from exactly one place in the code
(`resolveCheckpoint` at `checkpoint_final`), and only after verification has
actually passed and both reviewers approved. See `src/orchestrator/pipeline.ts`.

## Setup

```bash
npm install
cp .env.example .env
```

By default all three roles run as deterministic **mock agents** (no keys,
no browser) so you can see the pipeline logic work end to end:

```bash
npx tsx src/cli.ts new "Thêm dark mode cho app"
npx tsx src/cli.ts continue <taskId> --approve
npx tsx src/cli.ts continue <taskId> --approve   # ships it (stage: done)
npx tsx src/cli.ts status <taskId>
```

To ask for more work on something already shipped, without losing its
history (idea brief, architecture spec, prior implementation) or starting
a new task from nothing:

```bash
npx tsx src/cli.ts amend <taskId> "Also add a settings page for notification preferences."
```

This reopens the task at `architecture` (so the spec gets updated to
match the new request, same reasoning as a checkpoint_final rejection)
and runs the full implementation → verification → review cycle again,
ending at a new `checkpoint_final` for you to approve.

### Turning on real agents

Set `GEMINI_PROVIDER=real` / `CLAUDE_PROVIDER=api|cli` / `MUSE_PROVIDER=real`
in `.env` as you wire each one up, with these keys:

- **Gemini** — `GEMINI_API_KEY` (Google AI Studio key). Flash/Flash-Lite
  models have the most generous free tier; Pro is more capable but has a
  much tighter (or no) free quota — check what's free for your account at
  https://aistudio.google.com.
- **Claude** — two ways to run it, no code change needed:
  - `CLAUDE_PROVIDER=api` + `ANTHROPIC_API_KEY` — calls `api.anthropic.com`
    directly, billed per token via the Claude Console (separate from any
    claude.ai subscription).
  - `CLAUDE_PROVIDER=cli` — shells out to the local `claude` CLI
    (`claude -p "..."`) instead, using whatever Claude Code subscription
    it's already logged in with on this machine (Pro/Max usage), so no
    extra per-token billing and no `ANTHROPIC_API_KEY` needed. Requires
    `claude` to be installed and logged in on this machine.
- **Muse** — needs a real, logged-in Chrome session, so this only works on
  a machine you keep running (your own computer / a server you control),
  not in a throwaway container:
  1. `git clone https://github.com/duclm1x1/Muse-Chat-MCP.git` next to this
     repo, then `cd Muse-Chat-MCP && npm install`.
  2. `npm run selftest` — a Chrome window opens, log in with your Meta
     account. The session is saved under `.muse-profile/` and reused after
     that.
  3. In `.env` here, set `MUSE_MCP_SERVER_PATH` to the absolute path of
     `Muse-Chat-MCP/muse-server.mjs`, and `MUSE_PROFILE_DIR` to its
     `.muse-profile` folder.

### How code actually lands on disk

The `implementation` stage looks for lines starting with exactly
`FILE: relative/path/to/file.ext`; everything up to the next such line (or
the end of the reply) becomes that file's full contents. A wrapping
```fenced``` code block is stripped if present, but isn't required —
agents don't reliably add one even when asked to.

Anything before the first `FILE:` marker is kept for the record but not written.
Each file is written under `VERIFY_CWD` (paths escaping that directory are
rejected) — this is what `verification` then actually builds/tests. If a
reply has no `FILE:` blocks, nothing is written and that's logged, instead
of silently treating the reply as a no-op success.

### The verification gate

`VERIFY_CWD` + `VERIFY_COMMANDS` point at the real project Muse is coding
in and the commands that prove it works (e.g.
`npm install,npm run build,npm test`). This is what actually gates
`done` — not any agent's say-so.

### Visual review loop (optional, for UI/visual projects)

For projects where "matches the spec" is partly a visual judgment (a
3D scene, a UI), set `REFERENCE_IMAGE_PROMPT` in `.env`. Each task
**snapshots** `VERIFY_CWD`, `VERIFY_COMMANDS`, `REFERENCE_IMAGE_PROMPT` and
`BUILD_OUTPUT_DIR` from `.env` at the moment it's created (`new`) — so
switching `.env` to a different project afterwards doesn't retroactively
change an in-flight task's rules, and a task created without an image
prompt never picks one up from a later, unrelated task's `.env` change.
(Tasks from before this existed have no snapshot and fall back to
whatever `.env` currently says, same as before.)

Setting `REFERENCE_IMAGE_PROMPT` turns on:

1. At ideation time, Gemini generates a reference image from that prompt
   (saved to `data/visual/reference.png`) — write the prompt yourself to
   describe exactly the look you want; it isn't derived automatically from
   the idea brief.
2. After each verification pass, the orchestrator serves `BUILD_OUTPUT_DIR`
   (default `dist`) as static files on a fresh, randomly assigned port and
   takes a real headless screenshot (`data/visual/screenshot.png`) with
   Playwright. This deliberately does **not** start the project's own dev
   server: a dev server left running from a crashed or interrupted earlier
   attempt could otherwise keep answering on the same port and silently
   get screenshotted instead of the current build — serving the build
   output directly on a new port each time means a screenshot can only
   ever reflect what's on disk right now.
3. Gemini's review is then given both images and asked to compare them
   directly — composition, color, mood, missing/extra elements — not just
   whether the build succeeded.

Both steps fail soft: if image generation or the screenshot fails, it's
logged and the pipeline continues with a text-only review rather than
blocking. Needs `npm install` (pulls in `playwright`) and, once,
`npx playwright install chromium` on this machine.

## Dashboard (10 parallel department slots)

```bash
npm run dashboard
```
then open http://localhost:4000. Ten fixed "department" slots (AG-01
Product Lead … AG-10 Release Manager) each map to one real task — typing a
goal and clicking a slot's own button creates/continues *that department's*
task through the exact same pipeline as the CLI; "Chạy luồng cả công ty"
queues all ten. A slot showing "Waiting" is parked at a checkpoint and
shows Duyệt/Từ chối buttons right there instead of needing the CLI.

All ten actions share **one queue, processed strictly one at a time** —
"run the whole company" does not fire ten simultaneous bursts of
Gemini/Claude/Muse calls, which would multiply exactly the kind of
free-tier rate-limit burst this project has already had to work around.
`Reset` un-assigns tasks from all slots (it doesn't delete the underlying
task files in `data/tasks/`).

## What's next

This covers the orchestration ("company") model, an optional visual
review loop, and a dashboard for running several departments against the
same pipeline. `data/tasks/*.json` remains the source of truth either way
— the dashboard is just another reader/writer of it, like the CLI.
