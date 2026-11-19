**English** | [简体中文](README.zh-CN.md)

# devcontrol v6 — a discipline kernel for coding agents

Keeps Claude Code / Codex CLI / Cursor / OpenCode working **inside one set of rules**: claim a task before touching code, only touch files in your scope, and hand over evidence that you actually ran the check (command + exit code + content fingerprint). The kernel verifies that evidence — it never runs your tests.

A human does three things: **intake, approve, unblock**. The agent walks the rest of the pipeline.

- **Next step is decided by the kernel**: `bootstrap.next` orders by "finish what's open > dependencies satisfied > uncovered acceptance > blocked", so nobody has to pick.
- **One source of truth**: `.devcontrol/state.db` (a single SQLite file, WAL). Markdown is never the source of truth; `devcontrol export` is a read-only snapshot.
- **Contracts live in git**: `.devcontrol/contracts/<pathId>.json` is written and committed when the Owner approves, and the agent can only read it.
- **This is a separate project** (`mcp-devcontrol`). v4/v5 of `mcp-probe-kit` keep their own package name and MCP identity — you don't have to uninstall v4 to use `devcontrol`.
- **Lineage**: v6's design was distilled from experiments in mcp-probe-kit v5 (a transitional release, now frozen), but the identity, package name, data directory and MCP registration are all independent.
- **Migration**: memories from v5 can be pulled out of Qdrant with `node scripts/v5-import.mjs --qdrant http://127.0.0.1:6333 --collection <v5-collection>` (dry-run by default, add `--write` to persist). v5 itself is untouched.
- **How discipline is decided** is written down in `docs/03-discipline-core.md` (v8.8); architecture, trade-offs and phasing in `docs/04-v6-architecture.md`. Both ship with the repo, not with the npm package.

---

## 1. Install

```bash
# Node >= 22.5 (needs the built-in node:sqlite DatabaseSync), git >= 2.30
node -v && git --version
npm install          # only dependency: @modelcontextprotocol/sdk

cd devcontrol
npm link             # afterwards `devcontrol` works in any directory
# or skip linking and call it by absolute path: node /path/to/devcontrol/bin/devcontrol.js ...
```

No build step. The only runtime dependency is the official `@modelcontextprotocol/sdk` (protocol layer); everything else — storage, HTTP console, process spawning — uses Node built-ins (`node:sqlite` / `node:http` / `node:child_process`). Nothing talks to the network.

## 2. Initialize inside your project

**Two ways in — pick one:**

| Mode | Command | What you get | Cost |
|---|---|---|---|
| MCP (recommended) | `devcontrol init` | The agent calls the `devcontrol` tool directly in its session; the console is started for you; discipline ships via `instructions` | Register once in the client (init writes config for the four big ones) |
| CLI only | `devcontrol init --no-mcp` | Same gates and evidence chain; the agent uses `devcontrol status/commit/close`; the Owner uses `devcontrol intake/approve` — never opens a browser | The rules travel via `AGENTS.md` |

A full loop in CLI-only mode, entirely in the terminal:

```bash
devcontrol init --no-mcp
devcontrol intake "Make the homepage headline readable" --accept "npm test :: exit==0"
devcontrol approve FR-001 --path P-001        # approve; the contract is frozen into git
devcontrol next                               # kernel says what's next; last line is paste-ready
devcontrol run -- npm test                    # run the check yourself, leave evidence
devcontrol close
```

`intake` / `approve` are Owner actions and also exist in the console. There is no password (that would be security theatre), but the kernel records **which entry point** the approval came from (`channel=cli` vs `channel=owner`), so it's auditable afterwards.

**MCP is optional.** State, contracts, gates and evidence all live in `.devcontrol/state.db` + git; the CLI and the MCP server call the same functions. MCP only saves the agent a shell call and hangs the console lifecycle off the connection.

### What `init` actually writes

```bash
cd <your-repo>
devcontrol init
```

Five things:

1. Creates `.devcontrol/` (`state.db` / `contracts/` / `runs/`) and adds `state.db*`, `runs/` and `.devcontrol/context-plan.md` to `.gitignore`.
2. Creates one **draft Path** per top-level directory (`allowed_paths` + line budget + test command), status `draft`, waiting for the Owner.
3. Writes MCP config for four clients (pointing at your local `bin/devcontrol.js`, with `DEVCONTROL_ROOT` set): `.mcp.json` (Claude Code), `.cursor/mcp.json` (Cursor), `opencode.json` (OpenCode); the `~/.codex/config.toml` snippet is printed for you to paste once.
4. Appends a `<!-- devcontrol:begin -->` block to `AGENTS.md` telling the agent to `bootstrap` first, `claim` before editing, and never touch acceptance.
5. Starts nothing. The console comes up by itself the moment an MCP client connects (see 3.3).

`init` **commits** the files it wrote as `chore(devcontrol): init` — otherwise your first `close` gets stopped by `E_DIRTY_SCOPE`.

If the repo is moved or copied, run `init` again: a stale `DEVCONTROL_ROOT` in `.mcp.json` is rewritten to the new path, and your other MCP servers are left alone.

### Connect and go

With MCP you **don't have to remember to run `init` first**. When a client connects to a repo that has no `.devcontrol/`, the kernel initializes it and reports what it did once, in `bootstrap.autoInit`.

Once, not every time: repeating it on every connect turns into noise, and people start tuning noise out.

A non-git repo is **never** auto-initialized. No commits means no attribution, which means every gate is blind — building a database there would only manufacture false confidence.

### Project context: write it once, ship it with every task

Every new task used to start with the agent re-discovering "where are migrations, how are mappers named, where does business code go". In a small repo that's a few file reads; in a few-thousand-file repo it's pure waste.

So it's split into three moves:

1. **`init` produces a checklist, never the prose.** The kernel doesn't know your business, and writing it anyway would produce filler. It says *which* documents to write (architecture / data model / testing / error handling / how to add an endpoint…) plus a template skeleton for each. The agent writes the real content into `docs/project-context/`, as project files in git.
2. **`claim` inlines the content in its return value**, not just a path. A path means reading it is left to luck. If it's too long it degrades to "index + headings + paths" — but it never silently drops things.
3. **`close` checks whether that context went stale.** Three mechanical signals only: a directory the docs never mention, a dependency manifest that changed, or a `file:line` the docs cite that no longer exists. A hit requires one sentence — `contextNote` saying which document you updated, or why nothing needed updating.

Note that step 3 doesn't block "stale". It blocks **pretending you didn't notice**. Out of time? Say so. Just don't skip it silently.

## 3. The two workflows

### 3.1 Agent (MCP and CLI are equivalent)

The MCP surface is a single tool, `devcontrol`, with an `action` field (`wait` and `task.work` are the actions you call when `next` tells you not to touch the kernel yet):

| action | Purpose | Key constraint |
|---|---|---|
| `wait` | The kernel says hold (waiting on approval / a dependency / the Owner); returns current state | Changes nothing |
| `task.work` | You claimed a task but haven't written code or left evidence yet: the kernel says "your turn" and gives the four-step order (write → `run` → `commit` → `close`) | Changes nothing; it won't write your code or run your tests |
| `bootstrap` | Orientation: **`next` (the kernel's ordered next step)** + `actions` + `plan` (uncovered acceptance) + console URL | Must be your first action; follow `next`, don't pick your own |
| `task.create` | Split work into a task (scope / acceptance / dependencies / budget) | Acceptance command must be in the Path contract's allowlist |
| `task.claim` | Claim a task (45-minute lease, WIP=1) | Rejected if the scope overlaps another open task |
| `task.renew` | Extend the lease for long tasks (writes like `commit` renew automatically) | If the lease was already reclaimed → `E_CLAIM_STALE`, re-`task.claim` |
| `evidence.record` | Over MCP: hand up the acceptance result you got in your own shell (`command` verbatim + `exit`) | Command must be allowlisted; only the latest run against the current code is kept |
| `task.close` | Close: **verify the evidence the agent left** (does not execute tests) | Needs delivery commits + evidence on current code satisfying every assertion |
| `bug.report` | Report a bug (symptom + repro steps) | Cannot touch code directly |
| `ask` | Ask when ambiguous, don't guess | Task goes `parked`, returns to the queue once answered |
| `memory.write` | Record a reusable lesson anytime (pitfall / how-to / convention / snippet) | Rejected ones go to a quarantine area with a rewrite template |
| `memory.search` | Search this project's memory | Read-only; accumulates `hits` |
| `release.create` / `release.plan` / `release.ship` | Releases: a release ships only when every task in it is done | Empty releases and unfinished tasks are blocked |

CLI equivalents (for clients without MCP):

```bash
devcontrol status                     # = bootstrap
devcontrol commit -m "feat: ..."      # commits only files in scope; writes Task-Id / DevControl-Base trailers
devcontrol renew                      # = task.renew (45-minute lease; commit renews too)
devcontrol close                      # = task.close (defaults to your single open task)
devcontrol run -- npm test            # run and record exit code, output and duration
```

A typical agent round:

```text
bootstrap → task.claim(T-003) → write code → devcontrol commit -m "..." → task.close
                                                          ↑ kernel verifies the evidence you left; it does not run tests
```

### 3.2 Owner (the console)

You don't start the console yourself — it comes up with the MCP connection (see 3.3). To keep it running manually:

```bash
devcontrol serve            # foreground, http://127.0.0.1:7373
devcontrol serve --stop     # stop this project's console only (won't kill another project's)
```

Owner actions live on the console **and**, where marked, on the terminal. `intake` and `approve` both have CLI entry points (see §2) — a CLI-only project must not dead-end.

| Action | What it does |
|---|---|
| `intake` | File a requirement or a bug (also `devcontrol intake`) |
| `approve` | Freeze requirement + Path together and commit the contract (also `devcontrol approve`) |
| `amend` | Change acceptance or paths; open tasks fall back to backlog |
| `adjust` | Change a task's scope / budget |
| `reopen` | Send back / make a parked task claimable again |
| `abandon` | **Void a requirement**: archive it and drop its open tasks (irreversible, needs a reason) |
| `decide` | Accept or reject a bug |
| `answer` | Answer an agent's question; the task returns to the queue |
| `override` | Waive one blocking code (one-shot), or `force-close` |
| `path.adjust` / `path.retest` | Change a Path's budget / re-detect acceptance commands |
| `handoff` | Produce a handoff card you can paste to another agent |
| `memory.*` | Promote, edit, discard lessons |
| `settings.save` / `release.ship` | Save settings / tag a release |

The console has nine views in the sidebar: **Inbox** (requirements awaiting approval / questions awaiting answers / bugs awaiting a verdict / parked tasks / lessons awaiting promotion), **Requirements**, **Bugs**, **Tasks**, **Releases**, **Memory**, **Docs**, **Evidence** (command, exit code, HEAD, fingerprint for every run), **Settings**.

> `abandon` is the only way to say "we're not doing this". Without it, parked tasks can only be reopened and requirements have no terminal state — they keep occupying coverage while the agent's `next` waits forever for a reopen that will never happen.

### 3.2b Two machines: reaching the console over the LAN

By default it listens on loopback only (`127.0.0.1`), so no other machine can connect. To open it from another computer:

```bash
devcontrol serve --host 0.0.0.0
# devcontrol console: http://127.0.0.1:7373
#   over LAN (open directly from the other machine): http://192.168.0.107:7373/
#   anyone on the same LAN can open it. `devcontrol serve --stop` closes it.
```

That's it — no token, no login, no extra step.

To harden it, set one environment variable; the check only kicks in if it's set:

```bash
DEVCONTROL_OWNER_TOKEN=pick-something devcontrol serve --host 0.0.0.0
# then open http://192.168.0.107:7373/?token=pick-something
# the page stores the token in localStorage and sends it as X-Owner-Token
# (no cookies, so a request from another site can't carry it)
```

One boundary that always holds: the `Host` header must be loopback or a local interface address; anything else gets a 403 (this blocks DNS rebinding). It costs nothing and stops a class of attacks that needs no cooperation from you.

You can also skip the open port entirely — an SSH tunnel is equivalent and doesn't expose the LAN:
`ssh -L 7373:127.0.0.1:7373 you@192.168.0.107`, then open `http://127.0.0.1:7373/` locally.

### 3.3 The console is owned by MCP (same as v5 — no starting, no restarting)

The MCP connection is the console's lifecycle trigger. On startup `runMcp` calls `ensureConsole(root)`:

1. Take this project's lock `.devcontrol/console.lock` (exclusive `wx` create; reclaimed automatically if the holder dies or after 30s) so concurrent MCP servers don't step on each other;
2. Probe `GET /api/meta` starting from `DEVCONTROL_PORT`/`7373`:
   - **it's this project's own instance** → `SIGTERM`, wait for the port, restart on the same port with the current code (so an upgrade never leaves an old process running);
   - **it's another project** → never kill it, move to the next port;
   - **something else holds it** → move to the next port;
   - **free port** → start there;
3. The new process is `detached`, logs go to `$TMPDIR/devcontrol-console-<project-hash>.log`, and MCP exiting doesn't take the page down;
4. `bootstrap` puts the URL in the `console` field so the agent can tell the Owner. `AGENTS.md` says the same.

The buttons nobody has to press:

- **No start**: it exists as soon as MCP connects.
- **No restart**: if the console is stopped or crashes, the next `bootstrap` notices the address is dead and **rebuilds it in place**.
- **No page refresh**: the page polls every 4s, shows "reconnecting…" when the line drops, and returns to "connected" by itself.
- **No mutual killing**: an instance started less than 10s ago is reused rather than restarted (`DEVCONTROL_RESTART_GRACE_MS`), so several MCP servers starting in a row don't thrash the page.

Two deliberate trade-offs:

- **Separate process**: restarting MCP doesn't interrupt your reading; the cost is the process lives until `devcontrol serve --stop` or a reboot.
- **No instance registry**: v5 kept a `workspace-runtime` record plus a version handshake; devcontrol identifies instances purely from `root/pid/startedAt` in `/api/meta` — one less state file that can drift.

Switches: `DEVCONTROL_CONSOLE=0` disables auto-start; `DEVCONTROL_PORT=<n>` changes the starting port; `DEVCONTROL_RESTART_GRACE_MS=<ms>` widens the grace window.

### 3.4 Project memory

**Memory belongs to the project**: pitfalls hit, conventions agreed, solutions used — it travels with the repo. Cross-project sharing is a future sync feature, not local default behaviour.

- Source of truth is this repo's `.devcontrol/memory.db` (one `pitfalls` table, not in git). Qdrant is only a **rebuildable vector index** — if it dies, no data is lost.
- Write: `memory.write` anytime (no task required). A `task.close` that failed at least once must carry `resolvedBy` (otherwise `E_NEED_RESOLUTION`), and the kernel records a pitfall automatically.
- **Not everything deserves to be stored**: too short, no observable signal, a one-off slip (typo / forgotten file / rename), or hard-coded private paths → goes to a **quarantine area** (`candidate`), not indexed, not recalled. `devcontrol memory promote M-xxx` promotes it. Same title dedupes automatically.
- Read: `bootstrap.memories` injects the top 3 matching the current task; `memory.search` queries explicitly.
- Rejection isn't deletion: hitting quarantine returns `E_MEMORY_CANDIDATE` plus a template — "when X happens, do Y (because Z)". Rewrite with `kind=howto` and it's stored.
- Dedupe: identical titles merge outright; with vectors available, similarity ≥ 0.9 merges instead of adding.
- The console inbox lists "lessons awaiting promotion" — edit one line, click, and it's promoted and indexed.
- Degradation: vector stack unavailable → keyword search (bigrams + LIKE), closing still works, `doctor` reports `MEMORY_INDEX_FAILED`.

```bash
devcontrol memory status                     # how many lessons, index state, which embedding/Qdrant
devcontrol memory search "worktree commits lost"
devcontrol close --resolved-by "evidence was from old code; re-ran against current HEAD"
devcontrol memory reindex                    # rebuild the vector store (no data loss)
devcontrol release create "v0.1" --target 2026-12-01
devcontrol release plan R-001 T-003 T-004
devcontrol release list
```

| env | default |
|---|---|
| `MEMORY_EMBEDDING_PROVIDER` / `MEMORY_EMBEDDING_URL` / `MEMORY_EMBEDDING_MODEL` | `ollama` / `http://127.0.0.1:11434` / `nomic-embed-text` |
| `MEMORY_QDRANT_URL` / `MEMORY_QDRANT_COLLECTION` | `http://127.0.0.1:6333` / `devcontrol_memory_<first 8 chars of project path>` |
| `DEVCONTROL_MEMORY` / `DEVCONTROL_MEMORY_DB` | `on` / `<project>/.devcontrol/memory.db` |

## 3.5 Who runs the tests: **the agent, not the kernel**

This is the division of labour the whole tool is built to protect:

| | Who | Output |
|---|---|---|
| Write code | Agent | A commit (with `Task-Id`) |
| **Run tests** | **Agent** | One **evidence** record from `devcontrol run -- <cmd>` (command, exit code, output, content fingerprint at that moment) |
| Verify evidence | Kernel | R2: is the command allowlisted? Was the evidence produced against this exact code? Does the exit code satisfy the assertion? |

```bash
devcontrol run -- npm test      # the agent runs it; recorded as evidence for the open task
devcontrol close                # the kernel only verifies, never executes
```

Why the kernel refuses to run it: the moment it starts executing tests it owns environments, dependency installs, timeouts, process reaping and clean checkouts. The tool gets heavier and starts fighting how your project actually works — that is exactly where v5 drifted off course. Today the kernel only ever answers three things: **whose work is this, which files changed, is the evidence enough**.

The cost, stated plainly: evidence is self-reported. The kernel verifies **consistency**, not **truthfulness**. It catches "ran, then edited code" (fingerprint changed), "closed without running" (no evidence) and "ran some other command" (allowlist). It cannot catch deliberate forgery. That's the trade-off: the workbench governs process, not character.

## 3.6 Standards: the kernel hands them out, it doesn't enforce them

Jira has **acceptance** only (did the feature work). Code quality relies on human review.
Here an AI writes the code and nobody reviews it, so somebody has to state what good code looks like for this project — that's where this goes slightly beyond Jira.

But **stating it ≠ policing it**:

| | Who |
|---|---|
| Hand out standards | Kernel: written into the contract, visible when the Owner approves, delivered when the agent claims |
| Follow them | Agent |
| Judge whether they were followed | **Owner** (the kernel only counts facts) |
| Run tests | Agent (evidence only exists if it ran); the kernel just verifies that evidence |

Standards are frozen into the Path contract (`.devcontrol/contracts/P-xxx.json`):

```json
"standards": {
  "enforced": ["scope"],
  "rules": [
    { "id": "scope",    "text": "Only touch files in the task scope; new files must land in scope too", "enforced": true },
    { "id": "budget",   "text": "One task changes at most 400 lines; more usually means split it" },
    { "id": "tests",    "text": "Don't touch dependencies or existing tests; new test files are fine (TDD is normal)" },
    { "id": "testconf", "text": "Don't touch test config (runner, coverage thresholds)" },
    { "id": "todo",     "text": "No TODO / FIXME / HACK markers; file it in the task title or an issue instead" }
  ]
}
```

- **`enforced: ["scope"]`** — scope is the only thing the kernel actually blocks. That isn't "code quality", it's the factual question of which task a line belongs to; without it the attribution chain breaks.
- **The other four are observations only**: at close the kernel counts them into `observations`, prints them to stderr, and shows them in the console. **They never block delivery. Judging is the Owner's job.**

```
Standards check (the kernel reports facts; you judge):
  · this task changed 312 lines > budget 400
  · touched dependencies / existing tests: package.json
```

The same standards surface in three places: when the Owner approves (console Path column), when the agent starts (`task.claim` return value / CLI output), and at close (the standards check).

## 4. The gates (this is the "law")

`task.close` evaluates in order; the first failure returns its code and writes an event:

| Stage | Check |
|---|---|
| R0 | Are there delivery commits in the range? Are there **unowned commits** (neither this task's trailer, nor someone else's normal trailer-bearing commit)? |
| R1 | **Scope only**: out-of-scope files, unregistered new files. Budget / leftover markers / test config / dependencies-and-existing-tests are **observed**, not blocked |
| R2 | **Verify the evidence the agent left**: command in the contract allowlist, evidence produced against the current code (matching content fingerprint), exit code satisfying the assertion. The kernel **never executes** tests |
| R3 | (Folded into R2: evidence not matching current code is `E_EVIDENCE_STALE`) |
| R4 | Attributed commit not on HEAD's ancestry → `E_UNMERGED_WORK` |
| Close | CAS the status to `done`; consume one-shot waivers; write the `close` event |

Failure counting: anything fixable in one step (`E_DIRTY_SCOPE` / `E_BUSY` / `E_TIMEOUT` / `E_NO_EVIDENCE` / `E_EVIDENCE_STALE`) does **not** increment `review_round`. Everything else accumulates; three failures auto-`park` the task, waiting for the Owner to `reopen`.

### What failure looks like (the agent branches on this)

**Success and failure are both JSON on stdout, and `ok` is always present.** Failures always carry `code` and `hint`:

```json
{ "ok": false, "code": "E_DEP_OPEN", "message": "Dependency T-001 is not finished",
  "data": { "dep": "T-001", "status": "doing" },
  "hint": "The dependency hasn't closed yet. Finish it (devcontrol close), or pick a task that doesn't depend on it." }
```

- `message` says **what** went wrong, `data` holds machine-readable detail (offending filenames, allowed commands…), `hint` says **what to do next**.
- stderr carries two human lines (`code: message` + `→ hint`) and can be discarded entirely without breaking a program.
- Exit codes: `0` success / `1` action refused / `2` usage error. **Never return 2 for a non-usage failure**, otherwise scripts can't tell "you typed it wrong" from "the kernel said no".
- Every error code reachable by an agent must have a hint; `test/failure-contract.test.js` scans the source and checks each one, failing on any missing.

### Error codes

| Code | Meaning |
|---|---|
| `E_NOT_REPO` / `E_SCHEMA_NEWER` / `E_ID_EXHAUSTED` | Environment and version |
| `E_NEED_APPROVED` / `E_NO_CONTRACT` / `E_CONTRACT` / `E_HASH_MISMATCH` | Not approved, missing contract, contract edited, hash mismatch |
| `E_ILLEGAL_TRANSITION` / `E_CLAIM_STALE` / `E_CLAIMED_BY_OTHER` / `E_WIP_LIMIT` / `E_SCOPE_OVERLAP` / `E_DEP_OPEN` | State and concurrency |
| `E_SCOPE_TOO_BROAD` / `E_FILE_TOO_LARGE` | Task split too coarse |
| `E_UNOWNED_COMMIT` / `E_NO_DELIVERY` | Commit attribution |
| `E_SCOPE_VIOLATION` / `E_UNREGISTERED_FILES` / `E_DIFF_BUDGET` / `E_LINT_TODO` / `E_TEST_CONFIG_TOUCH` / `E_DEP_OR_TEST_TOUCH` | R1 |
| `E_NO_EVIDENCE` / `E_EVIDENCE_STALE` / `E_ASSERTION_FAILED` / `E_UNMERGED_WORK` | R2–R4 (evidence) |
| `E_DIRTY_SCOPE` / `E_BUSY` | Environment; don't count as rounds |
| `E_USAGE` / `INVALID_ARGUMENT` | Bad command or argument (`E_USAGE` exits 2) |
| `E_NO_TASK` / `E_WEAK_NO_GIT` / `NOT_FOUND` | Nothing claimed, weak mode can't commit, no such id |
| `E_INTERNAL` | Fallback |

## 4b. Language agnosticism

The kernel does not assume you're an npm project. Acceptance commands are detected from what's actually there (see `src/testcmd.js`):

| Project contains | Detected command |
|---|---|
| `scripts.test` in `package.json` | `npm test` (switches to pnpm/yarn/bun when their lockfile is present) |
| `Cargo.toml` | `cargo test` |
| `go.mod` | `go test ./...` |
| `pytest.ini` / `pyproject.toml` / `tox.ini` | `pytest -q` |
| a `test:` target in `Makefile` | `make test` |

Two conventions:

- **Dependencies and build output**: `node_modules/`, `dist/`, `build/`, `out/`, `target/`, `coverage/`, `__pycache__/` and friends count as artifacts in any project (while untracked); **`bin/` only counts in Go projects** — in an npm package `bin/` is source (the `package.json` bin entry). The rules live in `src/vendor.js`, apply only to untracked files, and never overrule what git already tracks.
- **Default acceptance when creating a task**: without `--accept`, use the contract's first command — not a hard-coded `npm test`.

## 5. Data model (9 tables + meta)

`requirements` `paths` `tasks` `bugs` `docs` `questions` `events` `runs` `patch_ids`, plus `meta` (schema version, monotonic ID counters, one-shot waivers).

- IDs are monotonic and never reused: `FR-xxx` / `P-xxx` / `T-xxx` / `B-xxx` / `Q-xxx` / `D-xxx`.
- `runs` stores every acceptance command an agent ran, its exit code, HEAD, fingerprint, output (truncated at 20k) and duration — all re-checkable.
- The only write path is through kernel functions; a `done` row with no `close` event in the log is reported by `devcontrol doctor` as `GHOST_DONE`.

## 6. Self-checks

```bash
npm test            # full suite: real temp repos, real close calls, real MCP and console, no mocks
npm run packcheck   # before publishing: pack it, install into an empty dir, verify the deliverable
devcontrol doctor   # silent unless something's wrong; exits 1 on ERROR
devcontrol export   # markdown snapshot (read-only, don't edit state with it)
```

`npm test` tests **the source**; `npm run packcheck` tests **the package you'd publish**. Those are different things: a file missing from `files`, a wrong `bin` path, or two shipped instruction files contradicting each other all survive a fully green unit run. It does three things: actually `npm pack` and install into an empty directory, do a handshake with the official SDK, and check that the four instruction files (SKILL/AGENTS/CLAUDE/cursor) agree on the version and don't disagree on the order of steps.

`doctor` runs two groups with different jobs:

**"What did the agent do"** (reconciles repo against database)

| Code | Meaning |
|---|---|
| `GHOST_DONE` | `done` in the DB but no close event (someone edited the database directly, probably) |
| `STALE_CLAIM` / `STALE_CLOSING` | Lease expired / closing stuck |
| `PARKED_TASK` | A task failed repeatedly and got parked; waiting for you to reopen or abandon |
| `STALE_PATH` / `TEST_CMD_DRIFT` | The Path's directory is gone / the frozen acceptance command no longer matches |
| `DOC_DRIFT` / `SKILL_OUTDATED` / `DIRTY_TREE` | Registered doc changed / agent instructions outdated / working tree dirty |
| `OVERRIDDEN` / `WEAK_MODE` | Closes the Owner waived / weak mode with no commit chain |

**"Is the kernel self-contradictory"** (database only, ignores the repo)

| Code | Meaning |
|---|---|
| `NO_APPROVED_PATH` | An approved requirement, but not one approved Path |
| `ACCEPTANCE_NOT_IN_CONTRACT` | The requirement's acceptance command isn't frozen by any approved Path |
| `TASK_ASSERTION_DRIFT` | A task's assertion isn't in its Path's contract → that task can never close |
| `TASK_SCOPE_OUTSIDE_PATH` | Task scope exceeds what its Path allows |
| `TASK_REQ_UNKNOWN` / `TASK_REQ_NOT_APPROVED` | Task references a requirement that doesn't exist / isn't approved |
| `TASK_DEP_UNKNOWN` / `TASK_DEP_CYCLE` | Dependency points at a missing task / dependencies form a cycle |
| `TASK_PATH_UNKNOWN` / `TASK_CONTRACT_STALE` | Path is gone / task recorded an older contract (realigned on claim) |

The second group exists to catch "both sides think they're right": the Owner sees approved in the UI while the agent sees unapproved; or the requirement plainly says "the build must pass too" while the contract only froze a test command. Those states produce **no exception anywhere** — the only way to see them is to lay both sides next to each other.

## 7. Mapping to the design docs

| Doc (`docs/03` v8.8) | Code |
|---|---|
| §4 data model, monotonic IDs, event log | `src/db.js` |
| §5 Path contract (committed on approval, read only from git) | `src/contract.js`, `src/store.js::reqApprove` |
| §6 R0–R5 evaluation | `src/gates.js::taskClose` |
| §7 attribution (trailer / patch-id / time window / scope) | `src/gates.js::decorate/validOwner`, `src/git.js::trailers/patchId` |
| §8 failure counting and parking | `src/gates.js::taskClose` finally block |
| §9 Owner surface | `src/store.js` + `src/console.js` + `public/index.html` |
| Console lifecycle tied to MCP (aligned with v5) | `src/console-boot.js`, `src/mcp.js::runMcp` |
| §10 Agent surface | `src/mcp.js` |
| §11 Reconciliation and export | `src/report.js` |

## 8. Deliberately out of scope (not forgotten — not in this version)

- patch-id fallback only identifies "this task's own history was rebased"; it is not a full merge proof across branches or cherry-picks.
- New files must be **explicitly listed** in `task.scope`, or allowed by the Path's `allow_new_files`; `allow_new_files` can only be set when the Path is created (no console toggle).
- No worktree isolation: the kernel never executes your tests, so it doesn't need a clean copy.
- No approval chains, no lease recovery, no multiple Owners. One Owner.
- No account system: no usernames, passwords or roles in the console. Cross-machine access uses a one-shot token, not a login.
- When `amend` pushes a Path back to `draft`, the console only informs you; there's no one-click re-approve (use `approve`).