# AI Company — orchestrator

A small "company" of AI agents with fixed roles and mandatory cross-checks.
No agent can mark its own work "done" — the next role always has to sign
off, and nothing ships until real verification commands (build/tests) have
actually passed.

## Roles

| Role | Agent | Does | Does NOT do |
|---|---|---|---|
| Idea lead | Gemini | Drafts the idea brief, later reviews the implementation | Write code, approve its own idea |
| Architecture lead / final sign-off | Claude | Writes the implementation spec (no code), gives the final go/no-go | Write code |
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
  -> checkpoint_final (YOU)        -- reject sends it back to implementation
  -> done
```

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

The `implementation` stage expects the engineer's reply in exactly this
shape, one block per file:

```
FILE: relative/path/to/file.ext
```
<full contents of the file>
```
```

Anything outside `FILE:` blocks is kept for the record but not written.
Each file is written under `VERIFY_CWD` (paths escaping that directory are
rejected) — this is what `verification` then actually builds/tests. If a
reply has no `FILE:` blocks, nothing is written and that's logged, instead
of silently treating the reply as a no-op success.

### The verification gate

`VERIFY_CWD` + `VERIFY_COMMANDS` point at the real project Muse is coding
in and the commands that prove it works (e.g.
`npm install,npm run build,npm test`). This is what actually gates
`done` — not any agent's say-so.

## What's next

This covers the orchestration ("company") model only. The 3D/WebGL
"office" interface is a later layer on top of this task store — the CLI
and `data/tasks/*.json` already give it everything it needs to render.
