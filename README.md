# AI Company — orchestrator

A small "company" of AI agents with fixed roles and mandatory cross-checks.
No agent can mark its own work "done" — the next role always has to sign
off, and nothing ships until real verification commands (build/tests) have
actually passed.

## Roles

| Role | Agent | Does | Does NOT do |
|---|---|---|---|
| Idea lead | Gemini | Drafts the idea brief; discusses the architecture spec with Claude before any code is written; later reviews the implementation | Write code, approve its own idea |
| Architecture lead / final sign-off | Claude | Writes the spec, revises it based on Gemini's feedback (no limit on rounds), mentors the engineer with a precise step-by-step guide (no code); after any review, decides for itself whether the feedback holds up and gives exact fix-it instructions when it rejects; gives the final go/no-go | Write code |
| Engineer | Muse (via MCP, browser-driven) | Implements the spec in code | Review or approve its own work |
| CEO | You | Approves the idea, approves the final ship | Everything else |

## Pipeline

```
ideation (Gemini)
  -> checkpoint_idea (YOU)         -- reject sends it back to ideation
  -> architecture (Claude writes/revises the spec)
  -> architecture_review (Gemini discusses it)    -- reject loops back to architecture, no round limit in practice
  -> implementation (Muse)
  -> verification (real commands: build/tests)    -- failure loops back to implementation
  -> review_gemini (independent review)           -- verdict always goes to review_claude next, never loops back by itself
  -> review_claude (Claude's own ruling, always final)  -- reject loops back to implementation
  -> checkpoint_final (YOU)        -- reject sends it back through ideation (a redesign, not a quick fix)
  -> done
```

**Architecture is a discussion, not a one-shot spec.** After Claude writes
it, Gemini reads it against the idea brief and either signs off or rejects
with specifics (what's missing, ambiguous, or risky). A rejection sends it
back to Claude for a real revision — not just the previous draft again —
and Gemini reads the new version next round. This can go on indefinitely
(`MAX_ARCHITECTURE_ROUNDS`, default 20, is a safety ceiling meant to never
actually trigger, not a real limit); if it ever does trigger, the task is
marked `rejected` rather than silently shipping an unreviewed design.

**Claude always makes the real call on a code review, never Gemini alone.**
`review_gemini`'s verdict — approve or reject — always flows into
`review_claude` next; nothing at `review_gemini` loops back to
`implementation` by itself. Claude then decides independently whether
Gemini's objection (if any) is actually correct: it can agree (and must
then give exact, step-by-step fix instructions — which file, which
function, what the corrected logic should look like) or overrule Gemini and
approve anyway, explaining why. Only Claude's own verdict here can send the
task back to `implementation` or forward to `checkpoint_final`.

If Gemini's own retry budget is exhausted (its free tier is down for a
stretch — rate limited or overloaded), Claude stands in for just that
round's `review_gemini` rather than leaving the task stuck: logged clearly
as a stand-in, not a permanent reassignment, and still followed by Claude's
own `review_claude` ruling. The next round tries Gemini again.

`done` is reachable from exactly one place in the code
(`resolveCheckpoint` at `checkpoint_final`), and only after verification has
actually passed and Claude has signed off. See `src/orchestrator/pipeline.ts`.

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
  2. In `.env` here, set `MUSE_MCP_SERVER_PATH` to the absolute path of
     `Muse-Chat-MCP/muse-server.mjs`, and (optionally) `MUSE_PROFILE_DIR` to
     where you want its session saved.
  3. `npm run muse:login` — **not** that repo's own `npm run selftest`,
     which despite its README never actually waits for login (it launches
     Chrome, checks status once, and closes immediately — that's a bug in
     that repo, not a timeout you can tune). This script instead connects
     as an MCP client and calls its `muse_login` tool directly, which does
     wait (up to 15 minutes, `MUSE_LOGIN_TIMEOUT_SEC` to change that) — a
     Chrome window opens, sign in with your Meta account. The session is
     saved under `.muse-profile/` (or `MUSE_PROFILE_DIR`, if set) and
     reused after that; re-run `muse:login` only if that session expires.

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

## Dashboard (the company: 10 staff, 3 tiers, one scheduler)

> Running it on a real server with a domain: see **[DEPLOY.md](DEPLOY.md)**.
> The dashboard listens on `127.0.0.1` by default and refuses to listen
> anywhere else without `DASHBOARD_USER`/`DASHBOARD_PASSWORD` — whoever can
> reach it can make the agents write and run code.

```bash
npm run dashboard
```
then open http://localhost:4000. Ten fixed staff slots, ranked into 3 tiers
(`src/dashboard/slots.ts`):

- **Tier 1 — Sếp (1 slot):** AG-01 AI Product Lead — plans the work.
- **Tier 2 — Trưởng nhóm (3 slots):** AG-02 Market Researcher, AG-05
  Backend Architect, AG-08 QA & Security — each owns an epic and its
  integration/acceptance task.
- **Tier 3 — Nhân viên (6 slots):** AG-03, AG-04, AG-06, AG-07, AG-09, AG-10
  — own the subtasks.

Every task, whoever owns it, runs through the same pipeline as the CLI.
The dashboard runs on `src/orchestrator/scheduler.ts` (`Company`).

### "Chạy luồng cả công ty": Goal → Epic → Subtask + acceptance criteria

1. The goal goes to the boss. Claude drafts a **work tree** as JSON:
   1–3 epics (each owned by a team lead) with 1–4 subtasks each (owned by
   staff), every one with 2–5 **testable acceptance criteria**, and
   `dependsOn` links between subtasks (`src/orchestrator/planner.ts`).
2. Gemini reviews the plan (goal coverage, owners, testable criteria,
   dependencies that don't needlessly serialize work); Claude revises —
   up to `PLAN_MAX_REVIEW_ROUNDS`. Owners from the wrong tier and unknown
   dependencies are fixed automatically and listed; cycles, bad JSON or
   missing criteria go back to Claude to fix.
3. **You approve the plan once** (or reject with feedback → redrafted).
   That approval replaces each task's idea checkpoint, so planned tasks
   start straight at architecture.
4. Each subtask becomes a task for its owner; each epic gets an
   integration task for its lead that depends on all the epic's subtasks.
   Every task carries its acceptance criteria (shown to the architect,
   the architecture reviewer, the engineer and both code reviewers) and a
   shared brief listing the goal, its epic, and what teammates are doing
   — so work stays on-goal and nobody duplicates anyone else.

### Capacity: queues, parallelism and engine limits

- Each slot holds a **queue of tasks** (shown in its card: running /
  waiting / waiting for you / errors / done) and runs at most
  `SLOT_MAX_PARALLEL` of them at once (`SLOT_PARALLEL_OVERRIDES` per slot).
- The real limits are per **engine**, enforced on every call whatever
  stage makes it (`src/agents/limited.ts`): `CLAUDE_CONCURRENCY`,
  `GEMINI_CONCURRENCY`, and Muse = 1, always (one logged-in browser).
- Implementation + verification is one task at a time across the whole
  company, under a lock on `VERIFY_CWD`: every task writes into and builds
  the same project, so another task's files landing between one task's
  write and its build would make that build meaningless.
- So in practice: Claude architects and reviews several tasks while Gemini
  reviews others and Muse codes one — the top bar shows each engine's
  `running/limit · waiting`.

### Handoff and automatic retries

- When a task reaches `HANDOFF_ON` (default `checkpoint_final`: verified
  and signed off by Claude — dependents can start while you review; or
  `done`: only after you approve), it publishes a **handoff**: its files,
  criteria and a design excerpt, computed once (`src/orchestrator/handoff.ts`).
  Tasks depending on it start automatically and receive every upstream
  handoff in their context. If you later reject an upstream task that had
  already handed off, its dependents get a warning in their log.
- A stage that **crashes** (network drop, CLI error, timeout) is retried
  automatically (`STAGE_ERROR_RETRIES`, with backoff); if it still fails,
  the task pauses with the error shown in red on its card and a
  "Thử lại" button — the error is never fed to the next agent as if it
  were review feedback.
- A task that **runs out of attempts** (verification keeps failing, or
  reviews keep rejecting) goes back to Claude to revise the architecture
  with all the accumulated feedback (`MAX_AUTO_RECOVERIES`) before it's
  marked rejected — repeated failure usually means the guide was the
  problem, not just the code.
- On restart, the dashboard resumes any task that was mid-stage.

### Human-in-the-loop controls

- **Pause / Resume / Stop** (top bar). Pause starts nothing new and lets
  calls already in flight finish. Stop aborts them *now* — the Claude CLI
  process is killed, HTTP requests are cancelled, the Muse MCP call is
  cancelled — and that stage runs again from its start on Resume (it's
  logged as stopped, not counted as an error).
- **Directives** (steering). Type an instruction for the whole company
  (bar under the telemetry) or one staff member (✎ Chỉ thị on its card, or
  in its drawer). It is added to every agent call for those tasks from the
  next stage on, as "CEO directives — follow these; they override any
  earlier instruction", and stays until you remove it (×). Tick *làm lại*
  to also send work already past architecture back to Claude with the
  directive as feedback (a task mid-stage does that when its stage ends).
- **Approval gates** (🔒/🔓 on each card; AG-08 QA & Security and AG-10
  Release on by default; the boss's plan always waits for you). A gated
  slot's results only hand off to the next step after you approve them;
  an ungated slot hands off as soon as it's verified and Claude signed off.
- At a final checkpoint you can **Duyệt** (ship), **Yêu cầu sửa** (keep the
  design, back to implementation with exactly your change request), or
  **Từ chối** (a redesign from the idea).
- **Reassign / reprioritize**: drag a queued task row onto another card,
  click ↑ to put it first in its own queue, or use the drawer. Running tasks
  can't be moved (pause first); plan owners update to match.
- **⚖ Sếp đề xuất cân tải** (on the boss's card and the handoff panel):
  Claude, as the boss, gets every slot's load and unfinished tasks (what
  each is waiting on, what it unblocks) and proposes up to 6 reassignments
  or move-to-front changes, each with a reason — specialty fit first, not
  just the shortest queue (`src/orchestrator/rebalance.ts`). Moves that
  can't apply (a running task, a target that isn't a staff slot, a no-op)
  are dropped and listed. Nothing moves until you tick the ones you want
  and press *Áp dụng*; each applied move is traced on the task as decided
  by AG-01 and approved by the CEO, with the reason. A task that started
  running between the proposal and your click is skipped and noted.

### Engines, the review inbox and focus

- **Engine badge on every running card**: `● Claude` / `● Gemini` / `● Muse`
  while a call is running, or `⏳ Chờ slot Muse #2/3` while it waits for
  that engine — with ↑ to move it to the front of that engine's queue.
  Clicking an engine (on a card or in the telemetry bar) opens its queue:
  who is running and who waits, in the order they'll be served, each with
  ↑ Ưu tiên. Priority only reorders the wait; a step never switches to a
  different engine (that would break "every bot's work is checked by
  another bot" — the only engine swap is Claude standing in for a Gemini
  that is down, which stays automatic).
- **🔍 Đang thẩm định / ✋ Chờ bạn duyệt** (top right) count what Gemini is
  reviewing right now (designs, code, the plan) and what waits for you
  (tasks, the plan, a rebalance proposal). Either opens the **Hộp duyệt**:
  each waiting item shows how long it has waited and, at the final
  checkpoint, Build/test · Gemini · Claude verdicts and the gate; act on it
  right there — Duyệt, Yêu cầu sửa, Từ chối, or Bỏ qua (for later: hidden
  from the list, still waiting; see the *Để sau* tab).
- **🎯 Focus** on a card pins that agent: everything unrelated to it (not
  an input, output or assignment link) stays dimmed, its arrows stay drawn,
  and the Dòng chảy and Timeline views narrow to it too, until you clear
  the chip (or press Esc). "↔ Đường nối" now says Bật/Tắt.
- Time spent waiting for you at a checkpoint is recorded too, so the
  Timeline shows it — and the agents' own working time excludes it.

### Visibility

- **Telemetry bar**: company completion %, running / waiting / waiting for
  you / errors / done, run time, tokens (hover for the per-engine split) and
  cost. The Claude CLI reports an API-equivalent cost per call; Gemini and
  the Claude API are only priced if you set `*_PRICE_*_PER_MTOK`; Muse
  reports nothing, so its tokens are estimated from text length (marked *).
- **Cards** show a distinct state (Idle (Ready), Waiting on AG-xx, Running,
  Needs Review, Blocked, Done, Paused), who assigned the task and which
  slots it takes input from / hands off to, the current task plus how many
  are queued behind it, and the last run's duration, wait and tokens.
  Hovering a card (or any AG-xx mention) draws its input/output arrows and
  dims everyone else; "↔ Đường nối" shows every handoff arrow at once.
- **Click a card** (or a plan subtask, a flow card, a timeline bar) to open
  its drawer: full outputs (brief, architecture guide, Muse's reply,
  verification log, upstream handoffs), its artifacts, every agent call
  with the exact prompt and output, the full log, and the **decision
  trace** — why the boss gave it to this person and what it builds on (the
  plan now has to give a `rationale` and `inputs` per item), plus every
  reassignment, directive, gate approval and automatic recovery since.
  Full prompts/outputs are kept in `data/calls/<task>.jsonl`.
- **Views**: *Sơ đồ tổ chức* (the org chart, with the goal and work tree to
  the right of the boss and the handoff/bottleneck panel to the right of
  the leads), *Dòng chảy* (tasks moving across Phân tích → Kỹ thuật →
  Kiểm thử → Chờ duyệt → Xuất bản, with the column where the most tasks are
  waiting flagged as the bottleneck), *Timeline* (one row per staff member,
  one bar per stage attempt, striped where it waited for an engine, with
  the critical path — the dependency chain that determined the finish
  time — outlined; group by person or by role lane, color by status — Chạy,
  Chờ duyệt, Lỗi, Dừng, Xong — or by phase, zoom to the last 15 min / 1 h,
  filter by status and by AG-xx, hover for duration/tokens/engines, click
  to open the task), and *Sản phẩm* (every brief, guide, file and log the
  team produced: preview, download, or forward to another staff member as
  input material). Filters: Đang chạy, Cần duyệt / Lỗi, Đã xong.

### Context pruning

Each stage sends its agent only what that stage acts on
(`src/orchestrator/contextPruning.ts`): the architect gets no code or build
logs on a first pass, the engineer gets the spec, criteria and handoffs
(plus its previous attempt only on a fix round), reviewers get the code
and only the tail of the verification log, where failures are. Each
task's context was already isolated from the other nine staff's work —
the pruning cuts what accumulates within a task over many rounds.

### Live updates

The page receives **Server-Sent Events** (`/api/events`) and patches one
card at a time — no more re-rendering the whole grid every 3 seconds
(which also used to wipe out text typed into a feedback box). Claude (CLI
`--output-format stream-json`, or the API) and Gemini (`streamGenerateContent`)
stream their replies token by token into the running card. Muse-Chat-MCP
can't stream over MCP, so Muse's card shows elapsed time instead.

### Dry run

`MOCK_DELAY_MS=1500 npm run dashboard` (with all providers on `mock`) makes
each mock call take 1.5s and stream its reply, so you can watch the plan,
queues, parallelism and handoffs without spending any quota.

`Reset` un-assigns every task (task files in `data/tasks/` stay) and stops
running tasks after their current stage. "Duyệt tất cả đang chờ" approves
every task waiting at a checkpoint in one go, after a confirmation.
