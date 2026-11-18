# piq

Fast, terminal-aware one-off CLI runner for [Pi](https://pi.dev) (`@earendil-works/pi-coding-agent`).

Interactive `pi` loads extensions, skills, prompt templates, themes, MCP servers, `CLAUDE.md`/`AGENTS.md` trees, and session history; `pi --print` buffers output until the entire multi-turn run finishes. `piq` strips startup down to bare `pi --mode json`, gathers live context from your current terminal pane in parallel (<400 ms), streams compact tool progress to `stderr`, and streams assistant text live to `stdout` so pipes stay clean.

`piq` is **read-only by default**: the model can only use `read`, `ls`, `find`, and `grep`, and prints the commands you would run. Pass `-x` / `--execute` to let it run commands and edit files.

Zero runtime npm dependencies (Node.js >= 18 built-ins only).

## Prerequisites

- [Pi](https://pi.dev) installed and authenticated (`pi` on `$PATH` or `~/.pi/agent/bin/pi`)
- Node.js >= 18

## Install

Via `npm` or `bun` directly from GitHub:

```sh
npm install -g github:mnapolitano89/piq
# or
bun add -g github:mnapolitano89/piq
```

Or via standalone installer (`~/.local/share/piq` + symlink in `~/.local/bin/piq`):

```sh
curl -fsSL https://raw.githubusercontent.com/mnapolitano89/piq/main/install.sh | sh
```

## Usage

```sh
# Ask about what just happened in your terminal pane
piq why did that last command fail

# Default (read-only): inspects files and prints the exact commands to run
piq clean up temp files and logs older than 7 days

# Execute mode (-x): lets piq run commands and edit files, with live tool progress on stderr
piq -x make a compressed tar.gz of all the build_* folders here
piq -x what is taking up 20gb in this directory

# Options are only read before the first prompt word, so shell flags stay in the prompt
piq what does ls -t do

# Pipe stdin in and pipe stdout out (tool progress stays on stderr, or -q to silence)
# --final prints only the final answer, without intermediate narration
git diff --staged | piq -q --final write a conventional commit message
kubectl describe pod api-7f8d | piq summarize why this pod is crash-looping

# Attach files directly via Pi's @file syntax
piq @error.log @config.yaml explain the mismatch causing this crash

# Model tiers: fast by default, -s for the smart (high-thinking) model
piq convert timestamp 1763480000 to UTC      # fast tier (default)
piq -s audit this script for race conditions # smart tier
piq -m anthropic/claude-sonnet-4-5:medium explain main.rs

# Continue the last piq call in your full interactive pi session
piq -a
```

## Options

| Flag | Description |
| --- | --- |
| `-x, --execute` | Allow `bash`, `write`, and `edit` so piq can run commands and modify files |
| `-n, --dry-run` | Read-only tools (`read,ls,find,grep`); inspect and print commands without executing (default) |
| `-s, --smart` (`-t, --think`) | Use the smart model tier (`PIQ_SMART_MODEL`, config `smartModel`, or Pi's default model at `:high`) |
| `-f, --fast` | Use the fast model tier (the default; `PIQ_FAST_MODEL`, config `fastModel`, or an auto-detected fast sibling) |
| `-m, --model <id>` | Override the model for this run (`provider/model` with optional `:<thinking>`) |
| `-c, --context` | Load project `CLAUDE.md` / `AGENTS.md` context files (skipped by default for speed) |
| `-0, --no-term` | Skip shell history, terminal scrollback, and `cwd` snapshot |
| `-q, --quiet` | Suppress tool/retry progress on `stderr` (`stdout` answer only) |
| `-v, --verbose` | Stream live trailing `stdout`/`stderr` lines from `bash` tool calls |
| `--final` | Print only the final assistant answer at the end (no live streaming or intermediate narration) |
| `-a, --attach` | Continue the last piq call in interactive `pi` (see [Attaching](#attaching-to-the-last-call)) |
| `--init [zsh\|bash\|fish]` | Print optional per-pane shell hook for exit codes and `cwd` breadcrumbs |
| `--config` | Print resolved `pi` binary, model tiers, config paths, and active context sources |
| `-V, --version` | Print version |
| `-h, --help` | Print help |

Options must come before the prompt: everything from the first non-option word onward (or after `--`) is prompt text. `@file` arguments are recognized anywhere.

## Terminal Context & Secret Redaction

Before spawning `pi`, `piq` runs bounded parallel probes (pass `-0` / `--no-term` to disable):

1. **Location & Git**: shallow `cwd` listing (newest 35 entries with sizes and relative ages), active Conda/venv/Pixi environment, and `git status --short --branch`.
2. **Recent Shell Commands** (first available source):
   - **Optional `piq --init` shell hook** (any shell/terminal): exact per-pane commands, `$?` exit codes, durations, and `cwd` breadcrumb trail.
   - **Atuin** (auto-detected if `~/.local/share/atuin/history.db` + `sqlite3` exist): per-pane `$ATUIN_SESSION` commands, exit codes, durations, and `cwd` trail.
   - **Standard shell history** (zero-config fallback): `$HISTFILE`, `~/.zsh_history` (extended and plain), `~/.bash_history` (timestamped and plain), or `~/.local/share/fish/fish_history`.
3. **Terminal Scrollback** (auto-detected when supported):
   - `tmux` (`tmux capture-pane`)
   - WezTerm (`wezterm cli get-text`)
   - Kitty (`kitty @ get-text` when `allow_remote_control` / `$KITTY_LISTEN_ON` is enabled)
   - iTerm2 (`it2 session read` when iTerm2's `it2` utility is installed)

Secrets are redacted before anything enters the prompt (best effort, not a guarantee):

- values of secret-named environment variables (`*TOKEN`, `*SECRET`, `*PASSWORD`, `*API_KEY`, `*ACCESS_KEY`, `PGPASSWORD`, `MYSQL_PWD`, `*_PAT`, etc.) wherever they appear
- secret-named assignments and flags: `AWS_SECRET_ACCESS_KEY=…`, `--password=…`, `--token …`, `password: "…"`, `"api_key": "…"`, `?token=…`
- credentials in URLs (`postgres://user:…@host`), `Bearer`/`Basic` headers, and common token prefixes (`sk-`, `ghp_`, `github_pat_`, `glpat-`, `xox*-`, `AKIA*`)

The captured context is treated as **untrusted data**: scrollback can contain output from any program, file, or web page. It is written to a private `0600` temp file and attached to the user message as an `@file` (deleted when `piq` exits), never placed in the system prompt or on the command line, and the model is instructed not to follow instructions found inside it.

### Optional Per-Pane Shell Hook (`piq --init`)

Standard `.zsh_history` / `.bash_history` files mix tabs together, omit exit codes, and often only flush when a shell exits. To get per-pane exit codes (`exit=1 [FAILED]`), durations, and directory trails in any terminal with **0 ms Node startup overhead** on new tabs:

**zsh (`~/.zshrc`)**
```sh
mkdir -p ~/.config/piq && piq --init zsh > ~/.config/piq/init.zsh
echo '[ -f ~/.config/piq/init.zsh ] && source ~/.config/piq/init.zsh' >> ~/.zshrc
```

**bash (`~/.bashrc`)**
```sh
mkdir -p ~/.config/piq && piq --init bash > ~/.config/piq/init.bash
echo '[ -f ~/.config/piq/init.bash ] && source ~/.config/piq/init.bash' >> ~/.bashrc
```

**fish (`~/.config/fish/conf.d/piq.fish`)**
```sh
mkdir -p ~/.config/fish/conf.d && piq --init fish > ~/.config/fish/conf.d/piq.fish
```

Each interactive pane logs only its rolling tail to a `0600` file under `$XDG_RUNTIME_DIR/piq/` (or `${TMPDIR:-/tmp}/piq-$UID/` when that is unset) and deletes it automatically when the pane closes. The hook refuses to log if that directory is a symlink or owned by another user, and resets its mode to `0700`. An existing bash `EXIT` trap is preserved and still runs after the hook's cleanup.

## Attaching to the Last Call

`piq -a` opens your normal interactive `pi` (extensions, skills, all tools, `AGENTS.md`) with the last piq call's conversation already loaded, so a quick question can turn into real work without re-explaining it:

```sh
piq why is the build failing
piq -a            # follow up, edit files, run commands in full pi
```

- It runs in the directory where the piq call ran (or the current one if that directory is gone) and keeps the model the call used. `piq -a -s` or `piq -a -m <model>` switches model.
- The conversation is forked into a new pi session, so it also shows up in `pi --resume`. Running `piq -a` again starts over from the piq call; use `pi --continue` or `pi --resume` to get back to the interactive conversation.
- `--attach` needs an interactive terminal and takes no prompt; ask your follow-up inside pi.

To make this possible, each piq run is saved as a pi session under `${XDG_STATE_HOME:-~/.local/state}/piq/sessions/` (a private `0700` directory). Only the most recent run is kept; older ones are deleted when the next run finishes. A saved session contains your prompt, the answer, tool output, and the redacted terminal context. If the directory is unsafe (a symlink, owned by another user), piq warns and runs without saving.

## Stdin

Stdin from a shell pipe (`cmd | piq …`) or a redirected file (`piq … < file`) is always forwarded to `pi`, however slowly it is produced. When stdin is a socket, as with editors, agent harnesses, or Node's `spawn`, `piq` forwards it only if data or EOF arrives within 300 ms, so an idle, never-closed stdin cannot hang the run.

## Exit Status

`piq` exits with `pi`'s status. If `pi` is killed by a signal, `piq` exits `128 + N` (e.g. `130` after Ctrl-C), and `SIGTERM`/`SIGHUP` sent to `piq` are forwarded to `pi`. When the reader of `piq`'s stdout goes away (`piq … | head -1`), `piq` stops `pi` and exits `141`, like other Unix tools killed by `SIGPIPE`.

## Configuration & Model Resolution

`piq` has two model tiers and uses the **fast** tier by default; `-s` switches to the **smart** tier for harder questions. It works out of the box by inheriting `defaultProvider` and `defaultModel` from `~/.pi/agent/settings.json`:

- **fast (default):** a `flash`/`haiku`/`mini`/`nano`/`lite` sibling of Pi's default model on the same provider, at `:low` thinking, or Pi's default model at `:low` if no sibling is found
- **smart (`-s`):** Pi's default model at `:high` thinking

To customize tiers persistently, create `~/.config/piq/config.json` (or set `$PIQ_CONFIG`):

```json
{
  "fastModel": "anthropic/claude-haiku-4-5:low",
  "smartModel": "anthropic/claude-sonnet-4-5:high"
}
```

Environment variable overrides (these take precedence over the config file):

- `PIQ_FAST_MODEL` — default model (`provider/model[:thinking]`)
- `PIQ_SMART_MODEL` — model for `-s` / `--smart`
- `PIQ_MODEL` / config `model` — deprecated aliases for the fast model, used only when no fast model is set (`piq --config` flags them)
- `PIQ_PI_BIN` — explicit path to `pi` executable
- `PIQ_EXTENSIONS` — comma-separated Pi extensions to keep loaded under `--no-extensions`
- `PIQ_DISABLE_ATUIN=1` — skip opportunistic Atuin SQLite lookup

Run `piq --config` at any time to inspect resolved settings and active terminal integrations.

## License

MIT
