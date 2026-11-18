# piq --attach Implementation Plan

> Executed inline (user asked to proceed directly). Steps use checkbox syntax for tracking.

**Goal:** `piq -a` / `piq --attach` continues the most recent piq call in the user's interactive `pi`.

**Architecture:** Every run saves its conversation with `pi --session <file>` in a private state dir; after the child exits piq records a `last-session` pointer and prunes everything else except live runs. `--attach` forks that file with `pi --fork` in the call's original cwd, using the same model, with full extensions/skills and only the untrusted-context rule appended.

**Tech Stack:** Node.js >= 18 built-ins, `node:test`, mock `pi` scripts, `script(1)` for a pty in E2E.

Spec: `docs/superpowers/specs/2026-11-18-piq-attach-design.md`

---

## File map

| File | Responsibility |
| --- | --- |
| `lib/sessions.js` (new) | State dir resolution + safety checks, session file naming, pointer write/read, pruning, session header/model parsing |
| `lib/attach.js` (new) | Pure planning of an attach: resolve target, cwd fallback, model precedence, pi argv |
| `lib/args.js` | `-a` / `--attach` flag |
| `lib/pi-args.js` | `sessionPath` option replaces hard-coded `--no-session` |
| `lib/context.js` | Export the untrusted-context rule so normal runs and attach share one wording |
| `bin/piq.js` | Wire saving into normal runs; `runAttach` (TTY check, spawn with inherited stdio, signals, exit code); help text |
| `test/piq.test.js` | Unit + E2E tests |
| `README.md`, `CHANGELOG.md` | Docs |

## Interfaces (used across tasks)

```js
// lib/sessions.js
getStateDir(env, homeDir) -> string                      // ${XDG_STATE_HOME:-~/.local/state}/piq
ensureStateDirs(stateDir, { uid }) -> { ok: true, sessionsDir } | { ok: false, reason }
newSessionPath(sessionsDir, { now, pid }) -> string      // <iso-with-dashes>-<pid>.jsonl
pidFromSessionName(name) -> number | null
recordLastSession(stateDir, sessionPath, { pid }) -> boolean   // only if file exists; atomic rename
readLastSession(stateDir) -> string | null              // absolute path if pointer valid and file exists
pruneSessions(stateDir, { isAlive }) -> string[]        // deleted names; keeps pointer target + live pids
readSessionInfo(file) -> { cwd: string, model: string } // model "provider/id[:thinking]" or ""

// lib/attach.js
planAttach({ sessionFile, sessionInfo, parsed, resolved, currentCwd, dirExists })
  -> { piArgs: string[], cwd: string, notes: string[] }

// lib/context.js
UNTRUSTED_CONTEXT_RULE: string

// lib/pi-args.js
buildPiArgs({ ..., sessionPath })  // "--session <path>" when set, else "--no-session"
```

## Tasks

### Task 1: sessions module (TDD)
- [ ] Tests: state dir from `XDG_STATE_HOME` and default; `ensureStateDirs` creates 0700 dirs, tightens a pre-existing 0777 dir, refuses a symlinked dir; `newSessionPath` / `pidFromSessionName` round-trip; `recordLastSession` is a no-op for a missing file and writes the basename atomically otherwise; `readLastSession` rejects pointers containing `/` or naming missing files; `pruneSessions` keeps the pointer target and live-pid files and deletes the rest; `readSessionInfo` reads cwd and the last model/thinking entries and tolerates missing entries or garbage lines.
- [ ] Run, confirm failure (module missing).
- [ ] Implement `lib/sessions.js`.
- [ ] Run, confirm pass.

### Task 2: args + pi-args + shared rule (TDD)
- [ ] Tests: `parseArgs(["-a"]).attach === true`, `--attach`, bundled `-am model`; `buildPiArgs` emits `--session <p>` and no `--no-session` when `sessionPath` is set, `--no-session` otherwise; `buildSystemPrompt` still contains `UNTRUSTED_CONTEXT_RULE`.
- [ ] Implement; run, pass.

### Task 3: attach planning (TDD)
- [ ] Tests: default uses session model; `-s` uses `resolved.models.smartModel`; `-m` uses explicit model; missing session model omits `--model`; argv starts with `--fork <file>`, contains `--append-system-prompt UNTRUSTED_CONTEXT_RULE`, and contains none of `--no-extensions --no-skills --tools --no-context-files --mode`; missing cwd falls back with a note.
- [ ] Implement `lib/attach.js`; run, pass.

### Task 4: wire into bin (TDD via E2E)
- [ ] E2E (mock pi): a run passes `--session` inside `$XDG_STATE_HOME/piq/sessions`, pointer written after exit, second run prunes the first; `--attach` with no session exits 1 with the message; `--attach` with prompt words exits 2; `--attach` without a TTY exits 2; under a pty (`script`), `--attach` spawns pi with `--fork`, the session cwd, the session model, and propagates exit code 7.
- [ ] Implement saving in the normal run path (`process.on("exit")` records + prunes; unsafe state dir -> `--no-session` + warning) and `runAttach`.
- [ ] Run full suite, pass; mutation check (revert bin changes -> new tests fail).

### Task 5: docs, live verification, commit, push
- [ ] Help, README (Attaching section, saved-session privacy note, options row), CHANGELOG `0.3.0 (unreleased)`.
- [ ] Live: real `piq` call, then `pi --fork` of the saved file in print mode retains the answer; confirm only one session file remains after a second call.
- [ ] Commit, push to main, watch CI.
