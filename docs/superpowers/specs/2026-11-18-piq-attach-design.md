# piq --attach: continue the last piq call in interactive pi

Status: approved design (2026-11-18)

## Goal

`piq -a` / `piq --attach` drops the user into an interactive `pi` session that continues the most recent piq call, so a quick question can escalate into real work without re-explaining context.

## Decisions

| Question | Decision |
| --- | --- |
| Attached session setup | Full interactive pi: the user's extensions, skills, all tools, context files. Only the "terminal context is untrusted" rule is re-appended. |
| Attached session model | The model the piq call used. `-s` or `-m <id>` given with `--attach` overrides it. |
| Which call is "last" | The most recently finished piq call, globally (only one session is kept, so per-pane lookup is not meaningful). |
| Retention | Only the most recent session is kept at rest. |
| Call chaining | None. Each piq call remains an independent conversation. |

## Verified pi behavior (pi 1.5.0)

- `pi --session <path>` with a non-existent path creates the session file at exactly that path, also in `--mode json`.
- The session file's first line is `{"type":"session","cwd":...}`; it is followed by `model_change` (`provider`, `modelId`) and `thinking_level_change` (`thinkingLevel`) entries.
- `pi --fork <file>` creates a new session from that file in the current directory, under the active session store, and leaves the source file untouched. The fork retains conversation history.
- The system prompt, tools, skills, and context files come from the process that opens a session, not from the session file. The `@file` terminal context is already embedded in the stored user message.

## Design

### 1. Saving runs (`lib/sessions.js`)

- State directory: `${XDG_STATE_HOME:-~/.local/state}/piq`, sessions in `<state>/sessions/`. Both are created with mode 0700. piq refuses to use them if either is a symlink, not owned by the current user, or group/world-writable after creation; in that case the run proceeds with `--no-session` and a one-line stderr warning, and `--attach` reports that saving is unavailable.
- Each run passes `--session <state>/sessions/<timestamp>-<pid>.jsonl` instead of `--no-session`.
- When the child closes (any exit, including signals), if the session file exists, piq atomically writes `<state>/last-session` (write to a temp file, then rename) containing the session file name, then prunes. Pruning deletes every `*.jsonl` in `sessions/` except the file named in `last-session` and files whose embedded pid is a live process (concurrent runs in other panes).
- Pruning and pointer failures never change piq's exit status; they produce at most a dim stderr note.

### 2. Attach (`--attach`, `-a`)

- Resolve `last-session`; if it is missing or the file does not exist: `piq: no previous piq session to attach to` on stderr, exit 1.
- Read the session header for `cwd`, plus the last `model_change` / `thinking_level_change` entries for the model (`provider/modelId:thinkingLevel`).
- Model: explicit `-m` > `-s` (resolved smart model) > session model. If no model can be determined, omit `--model` and let pi decide.
- Working directory: the session's `cwd` if it exists, else `process.cwd()` with a stderr note.
- Spawn `pi --fork <file> --append-system-prompt <untrusted-context rule> [--model <model>]` with `stdio: "inherit"` in that directory, without piq's `--no-extensions`/`--no-skills`/`--tools`/`--no-context-files` restrictions. Extensions needed for an extension-backed model are loaded normally.
- piq ignores SIGINT while pi runs (pi owns the terminal) and exits with pi's exit code (`128 + N` on signal).
- Usage errors: `--attach` combined with prompt words, `@files`, or piped stdin input.
- Re-running `--attach` forks from the piq call again. Continuing the interactive conversation itself is `pi --resume` / `pi --continue`.

### 3. Docs

- Help text, README (usage, options table, new "Attaching" section, saved-session privacy note), and a new `0.3.0 (unreleased)` CHANGELOG section. `v0.2.0` is tagged before this lands. The version in `package.json` stays 0.2.0 until a 0.3.0 release is cut.

## Testing

- Unit: state directory creation and its symlink, owner, and mode refusal; session file naming; pointer write; pruning keeps the latest and live-pid files and deletes the rest; session header and model parsing, including missing entries.
- E2E with a mock pi:
  - A run passes `--session <path>` inside the state dir, and `last-session` is updated only after exit.
  - A second run prunes the first.
  - `--attach` spawns pi with `--fork`, the session cwd, the session model, the untrusted rule, and no piq restriction flags.
  - `-s`/`-m` overrides apply.
  - Exit codes propagate.
  - With no session, exit 1 with the message.
  - When the cwd is missing, attach falls back to the current directory.
- Live: one real `piq` call followed by a scripted check that `pi --fork` of the saved file retains the answer.

## Out of scope

Per-pane history, chaining calls into one conversation, a flag to disable saving, and `--attach <message>`.
