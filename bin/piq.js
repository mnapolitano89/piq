#!/bin/sh
':' //; if ! command -v node >/dev/null 2>&1; then for d in /opt/homebrew/bin /usr/local/bin "$HOME/.volta/bin" "$HOME/.local/share/fnm/aliases/default/bin" $(ls -d "$HOME"/.nvm/versions/node/v$(cat "$HOME/.nvm/alias/default" 2>/dev/null)*/bin 2>/dev/null | tail -n 1); do [ -x "$d/node" ] && PATH="$d:$PATH" && break; done; export PATH; fi; exec node "$0" "$@"

"use strict";

/**
 * piq — Fast, terminal-aware one-off CLI runner for Pi (`pi --mode json --no-session`)
 *
 * Strips startup bloat (extensions, skills, context files, session persistence)
 * while gathering live terminal context in parallel and streaming tool executions
 * to stderr and assistant text to stdout.
 */

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT_DIR = path.resolve(fs.realpathSync(__filename), "..", "..");
const pkg = require(path.join(ROOT_DIR, "package.json"));
const { parseArgs } = require(path.join(ROOT_DIR, "lib", "args"));
const { loadResolvedConfig } = require(path.join(ROOT_DIR, "lib", "config"));
const {
  tildePath,
  detectContextCapabilities,
  buildTerminalContextBlock,
  writeContextFile,
  buildSystemPrompt,
} = require(path.join(ROOT_DIR, "lib", "context"));
const { buildPiArgs } = require(path.join(ROOT_DIR, "lib", "pi-args"));
const { classifyStdin, resolveStdinForwarding } = require(path.join(ROOT_DIR, "lib", "stdin"));
const { renderShellInit } = require(path.join(ROOT_DIR, "lib", "shell"));
const { signalExitCode, makeColors, createStreamProcessor } = require(path.join(ROOT_DIR, "lib", "stream"));

const isTTYErr = Boolean(process.stderr.isTTY);
const c = makeColors(isTTYErr);

function printHelp(resolved) {
  const defLabel = resolved.models.defaultModel || "Pi configured default (:low)";
  const fastLabel = resolved.models.fastModel || "auto fast sibling (:low)";
  const smartLabel = resolved.models.smartModel || "Pi configured default (:high)";

  const help = `
${c.bold("piq")} — quick, terminal-aware one-off CLI tasks with Pi

${c.bold("Usage:")}
  piq [options] [@files...] <command or question...>
  <cmd> | piq [options] <prompt...>

${c.bold("Options:")}
  -x, --execute        Allow running commands and editing files (bash/write/edit)
  -n, --dry-run        Read-only tools; print commands without executing (default)
  -f, --fast           Use fast model (${fastLabel})
  -s, --smart          Use high-thinking model (${smartLabel})
  -m, --model <id>     Override model (default: ${defLabel})
  -c, --context        Load project CLAUDE.md / AGENTS.md context files
  -0, --no-term        Skip shell history, terminal scrollback, and cwd snapshot
  -q, --quiet          Suppress tool progress on stderr (stdout only)
      --final          Print only the final answer (no intermediate narration)
  -v, --verbose        Stream live stdout/stderr from bash tool executions
      --init [shell]   Print per-pane shell hook (zsh, bash, or fish)
      --config         Show resolved models, pi binary, and active context sources
  -V, --version        Show version
  -h, --help           Show this help

Options are only read before the first prompt word, so
\`piq what does ls -t do\` keeps \`-t\` in the prompt.

${c.bold("Examples:")}
  piq why did that last command fail
  piq what command cleans up logs older than 7 days
  piq -x make a compressed tar.gz of all the t* folders here
  git diff | piq write a conventional commit message
`.trimStart();
  process.stderr.write(help);
}

function printConfigReport(resolved) {
  const caps = detectContextCapabilities();
  const lines = [
    `piq ${pkg.version}`,
    `  pi binary:        ${resolved.piBin}`,
    `  piq config:       ${tildePath(resolved.paths.piqConfigPath)}${resolved.hasPiqConfigFile ? "" : " (not created)"}`,
    `  pi settings:      ${tildePath(resolved.paths.piSettingsPath)}${resolved.hasPiSettingsFile ? "" : " (not found)"}`,
    `  default model:    ${resolved.models.defaultModel || "(defer to pi --thinking low)"}`,
    `  fast model (-f):  ${resolved.models.fastModel || "(defer to pi --thinking low)"}`,
    `  smart model (-s): ${resolved.models.smartModel || "(defer to pi --thinking high)"}`,
    `  provider exts:    ${resolved.extensions.length > 0 ? resolved.extensions.join(", ") : "(none needed)"}`,
    `  history source:   ${caps.historySource}`,
    `  scrollback:       ${caps.scrollbackSource}`,
  ];
  process.stdout.write(lines.join("\n") + "\n");
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) {
    process.stderr.write(`piq: ${parsed.error}\n`);
    process.exit(2);
  }

  if (parsed.version) {
    process.stdout.write(`piq ${pkg.version}\n`);
    process.exit(0);
  }

  if (parsed.initShell) {
    process.stdout.write(renderShellInit(parsed.initShell));
    process.exit(0);
  }

  const resolved = loadResolvedConfig({
    tier: parsed.tier,
    explicitModel: parsed.explicitModel,
  });

  if (parsed.help) {
    printHelp(resolved);
    process.exit(0);
  }

  if (parsed.showConfig) {
    printConfigReport(resolved);
    process.exit(0);
  }

  const promptText = parsed.promptWords.join(" ").trim();
  const stdinMode = classifyStdin();
  const needsStdinPrompt = !promptText && parsed.fileArgs.length === 0;

  if (needsStdinPrompt && stdinMode === "none") {
    printHelp(resolved);
    process.exit(1);
  }

  const [forwardStdin, termContext] = await Promise.all([
    resolveStdinForwarding({ mode: stdinMode }),
    buildTerminalContextBlock({ noTermContext: parsed.noTermContext }),
  ]);

  if (needsStdinPrompt && !forwardStdin) {
    printHelp(resolved);
    process.exit(1);
  }
  // Terminal context is untrusted (scrollback can contain arbitrary program output),
  // so it goes to Pi as a user-message @file attachment rather than system-prompt text.
  const contextFile = termContext ? writeContextFile(termContext) : null;
  if (contextFile) {
    process.on("exit", contextFile.cleanup);
  }
  const sysPrompt = buildSystemPrompt({
    cwd: process.cwd(),
    execute: parsed.execute,
    hasContextFile: Boolean(contextFile),
  });
  const piArgs = buildPiArgs({
    parsed,
    resolved,
    sysPrompt,
    promptText,
    contextFilePath: contextFile ? contextFile.path : "",
  });

  const child = spawn(resolved.piBin, piArgs, {
    stdio: [forwardStdin ? "pipe" : "ignore", "pipe", "pipe"],
    env: process.env,
  });

  child.on("error", (err) => {
    if (err && err.code === "ENOENT") {
      process.stderr.write(
        `${c.red("piq error:")} Could not find \`pi\` executable ("${resolved.piBin}").\n` +
          `${c.dim("Install Pi first (https://pi.dev) or set PIQ_PI_BIN=/path/to/pi.")}\n`
      );
    } else {
      process.stderr.write(`${c.red("piq error:")} ${err?.message || err}\n`);
    }
    process.exit(127);
  });

  if (forwardStdin && child.stdin) {
    child.stdin.on("error", () => {});
    process.stdin.pipe(child.stdin);
  }

  // Forward termination signals so pi can stop cleanly, then exit through the child's
  // close handler (which runs the context-file cleanup via process 'exit').
  // If the child ignores the signal, SIGKILL it rather than leaving an orphan behind.
  process.on("SIGINT", () => {
    child.kill("SIGINT");
  });
  for (const sig of ["SIGTERM", "SIGHUP"]) {
    process.on(sig, () => {
      child.kill(sig);
      setTimeout(() => {
        child.kill("SIGKILL");
        process.exit(signalExitCode(sig));
      }, 2000).unref();
    });
  }

  // Reader went away (`piq ... | head -1`): stop the child and exit like a
  // SIGPIPE'd Unix tool (141) instead of crashing with an EPIPE stack trace.
  process.stdout.on("error", (err) => {
    if (err && err.code === "EPIPE") {
      child.kill("SIGTERM");
      process.exit(signalExitCode("SIGPIPE"));
    }
    throw err;
  });
  // Nowhere left to report stderr failures; never crash on them.
  process.stderr.on("error", () => {});

  const processor = createStreamProcessor({
    stdout: process.stdout,
    stderr: process.stderr,
    quiet: parsed.quiet,
    verbose: parsed.verbose,
    finalOnly: parsed.finalOnly,
    isTTYErr,
    onAbortChild: () => child.kill("SIGTERM"),
  });

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => processor.feedStdoutChunk(chunk));

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => processor.feedStderrChunk(chunk));

  child.on("close", (code, signal) => {
    const exitCode = processor.finalize(code, signal);
    // Pipe writes are async on macOS: exit only after stdout has flushed, or the
    // tail of the answer (all of it with --final) can be lost.
    process.stdout.write("", () => process.exit(exitCode));
  });
}

main().catch((err) => {
  process.stderr.write(`${c.red("piq error:")} ${err?.message || err}\n`);
  process.exit(1);
});
