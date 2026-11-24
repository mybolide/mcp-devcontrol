**English** | [简体中文](README.zh-CN.md)

# devcontrol

A discipline kernel for coding agents.

It keeps Claude Code / Codex / Cursor / OpenCode on rails: claim a task before you touch code, only touch files that task owns, and prove you ran the check. The kernel verifies the proof — **it never runs your tests**.

You do three things: **file it, approve it, unblock it.** The agent walks the rest.

## The problem

Jira tracks features. Nobody tracks what the agent actually did.

- It says "all tests pass". Did it actually run them?
- It fixes a bug by editing a file three layers away from the bug.
- It adds a second helper that already exists.
- Two agents working in parallel quietly overwrite each other.
- Two weeks later, nobody can say which task a line belongs to.

## What changes

| Before | After |
|---|---|
| "Tests pass" — take its word for it | A recorded run: command, exit code, output, and the fingerprint of the code it ran against. Edit anything afterwards and the evidence goes stale |
| It edits whatever it thinks needs editing | Out-of-scope files are refused. One hard gate, nothing else |
| Every task re-explores the project | Your architecture/ conventions are written once and **attached to every task automatically** |
| Nobody knows who wrote a line, or why | Every commit carries its task id. "Why does this line exist" has an answer |
| You babysit the whole loop | You answer three things: approve, decide, unblock |
| "Is this tool actually helping?" | `devcontrol stats` / `report`: how often it blocked, how much rework, whether it ever actually said no |

## Three steps

```bash
npm install -g mcp-devcontrol     # Node >= 22.5, git >= 2.30
cd your-project
devcontrol init
```

`init` sets up state, freezes a draft contract per directory, writes `.mcp.json` (the generic MCP entry — Claude Code and others read it directly), and drops a rules block into `AGENTS.md`. **Client-specific** config is written only when the project already uses that client (`.cursor/`, `opencode.json` or `.opencode/`); ask for it explicitly with `devcontrol init --mcp-for cursor,opencode` (or `all`). Codex needs a manual snippet — `init` prints it.

Then, from your agent's session or a terminal:

```bash
devcontrol intake "Make the homepage headline readable" --accept "npm test :: exit==0"   # you
devcontrol approve FR-001 --path P-001                                                   # you
devcontrol next                                                                          # the kernel decides what's next
```

No MCP? `devcontrol init --no-mcp` — same gates, same evidence, everything in the terminal.

`init` also drops three version-locked entry points into the project — `.devcontrol/bin/devcontrol` (`devcontrol.cmd` on Windows). Use them when a client dropped the MCP tool lease, or in CI where devcontrol isn't installed: same kernel, no `node_modules`, no network.

The published package is **one self-contained file**: `npm run build` bundles the kernel and its dependencies into `build/devcontrol.js`, so an install runs as-is and an SDK major bump can't break an old version.
## One task, end to end

```text
bootstrap        → "claim T-003, scope src/, run npm test"
task.claim       → returns the task's scope, the test command, and your project context
   ...write code...
devcontrol run -- npm test      → recorded as evidence: command, exit code, fingerprint
devcontrol commit -m "..."      → commits only in-scope files, stamps the task id
devcontrol close                → verifies the evidence and closes. It does not run tests
```

Close fails if the evidence is missing, was produced against different code, or the command isn't in the contract. Fixing it is a normal step, not a rework round.

## How it stays small

Most tools in this space grow until they manage your environment. This one refuses:

- **It never runs your tests.** The moment it does, it owns installs, timeouts, process reaping, clean checkouts — and starts fighting how your project really works. The agent runs; the kernel checks that the evidence matches the code.
- **Scope is the only hard gate.** Whether a line is *good* is a judgement call. Whether a line *belongs to this task* is a fact. The kernel enforces facts.
- **Standards are handed out, not policed.** Line budget, no `TODO` markers, don't touch existing tests — these get counted and reported at close. You decide what to do about it.
- **It never writes your documentation prose.** It knows which documents a project needs and asks for them; your agent fills in the content, because the kernel doesn't know your business.

The honest limit: evidence is self-reported. It catches "ran, then edited the code" and "closed without running anything". It cannot catch deliberate forgery. The tool governs process, not character.

## Agent surface

One MCP tool, `devcontrol`, with an `action` field:

| action | Purpose |
|---|---|
| `bootstrap` | Start here. Returns `next` — the kernel's ordered next step — plus open questions and the console URL |
| `wait` | The kernel says hold; returns current state |
| `task.work` | Your turn to write code; returns the four-step order |
| `path.create` | Propose a Path draft for Owner review; it does not grant write access |
| `task.create` | Split work into a task (scope, acceptance, dependencies) |
| `task.claim` | Take a task (45-minute lease, one at a time) |
| `task.renew` | Extend the lease on a long task |
| `evidence.record` | Hand up the result you got in your own shell |
| `task.close` | Close: verify the evidence |
| `task.rework` | Retry a parked task yourself when the failure was yours to fix (same contract, capped) |
| `task.status` | One query: state, acceptance results, failures, rework history |
| `task.resume` | Recover a task whose agent died (release the expired lease) |
| `bug.report` | Report a bug with repro steps |
| `ask` | Ask when ambiguous instead of guessing |
| `memory.write` | Record a reusable lesson |
| `memory.search` | Search this project's memory |
| `release.create` | Start a release |
| `release.plan` | Attach tasks to a release |
| `release.ship` | Ship it, tag it, once every task is done |

CLI equivalents, for clients without MCP:

```bash
devcontrol status                 # = bootstrap
devcontrol path create --req FR-003 --allow docs/a.js --allow-new-files --budget 600 --test "node --test test/a.test.js"  # draft only; Owner approves
devcontrol run -- npm test        # run and record evidence
devcontrol commit -m "feat: ..."  # commit in-scope files
devcontrol close                  # verify and close
devcontrol task abandon T-003 --reason "not needed any more"
```

## A finished task says what it delivered

Closing is no longer just "the tests ran". `devcontrol close` now requires three things, stored in `task_completions` in `.devcontrol/state.db` (append-only):

```bash
devcontrol close T-003 \
  --summary "hero headline rewritten to plain language" \
  --changes "only the Hero component and its copy constants" \
  --limitations "mobile font size not verified on a device yet"
```

- A note is a note: the evidence is still the runs the kernel verifies (command, exit code, which code they ran against).
- Re-closing after a reopen **appends** a record instead of overwriting it; `devcontrol task show T-003` lists every round with its evidence, and `devcontrol export` has a matching section.
- Tasks closed before this existed show "未记录"; nothing is backfilled.
- Owner force-close is recorded too, but labelled "forced (unverified)" — never as a passing acceptance.
- Done ≠ human review: the kernel proves the gates, not the judgement.

## Your console, as a side effect

Connect an MCP client and a local console appears at `http://127.0.0.1:7373` — nine views: inbox, requirements, bugs, tasks, releases, memory, docs, evidence, settings. It starts itself, restarts itself if it dies, and never kills another project's instance. You never launch or refresh it.

## What it is not

- Not a board. No kanban, no sprints, no assignees.
- Not a linter. It won't tell you your code is ugly.
- Not a test runner.
- Not multi-user. One owner, no accounts.
- Not a rules engine. Five standards, one enforced.

## Docs

- `docs/03-discipline-core.md` — every rule, and why
- `docs/04-v6-architecture.md` — design and trade-offs
- `devcontrol --help` — every command
- `devcontrol doctor` — reconciles the repo against its database; speaks only when something's wrong

MIT.