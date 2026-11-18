"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { parseArgs } = require("../lib/args");
const {
  splitModelSpec,
  resolveModels,
  resolveRequiredExtensions,
  loadResolvedConfig,
} = require("../lib/config");
const {
  createRedactor,
  parseZshHistory,
  parseBashHistory,
  parseFishHistory,
  readPaneHookHistory,
  getStandardShellHistory,
} = require("../lib/context");
const { renderShellInit } = require("../lib/shell");
const { classifyError, createStreamProcessor } = require("../lib/stream");

const REPO_ROOT = path.resolve(__dirname, "..");
const BIN_PATH = path.join(REPO_ROOT, "bin", "piq.js");

test("parseArgs handles bundled flags, @files, -- passthrough, and preserves positional 'init'", () => {
  const r1 = parseArgs(["-nqv", "@foo.txt", "init", "a", "git", "repo", "--", "-f"]);
  assert.equal(r1.dryRun, true);
  assert.equal(r1.quiet, true);
  assert.equal(r1.verbose, true);
  assert.deepEqual(r1.fileArgs, ["@foo.txt"]);
  assert.deepEqual(r1.promptWords, ["init", "a", "git", "repo", "-f"]);
  assert.equal(r1.initShell, null);

  const r2 = parseArgs(["-qm", "openai/gpt-5:medium", "hello"]);
  assert.equal(r2.quiet, true);
  assert.equal(r2.tier, "explicit");
  assert.equal(r2.explicitModel, "openai/gpt-5:medium");
  assert.deepEqual(r2.promptWords, ["hello"]);

  const r3 = parseArgs(["--init", "bash"]);
  assert.equal(r3.initShell, "bash");

  const r4 = parseArgs(["--init"], { SHELL: "/opt/homebrew/bin/fish" });
  assert.equal(r4.initShell, "fish");

  const r5 = parseArgs(["--init", "powershell"]);
  assert.match(r5.error, /Unsupported shell/);
});

test("resolveModels inherits Pi settings, discovers fast siblings, and honors overrides", () => {
  const piSettings = {
    defaultProvider: "anthropic",
    defaultModel: "claude-sonnet-4-5",
    enabledModels: ["anthropic/claude-sonnet-4-5", "anthropic/claude-haiku-4-5"],
  };

  const def = resolveModels({ tier: "default", env: {}, piqConfig: {}, piSettings, piModels: {} });
  assert.equal(def.selectedModel, "anthropic/claude-sonnet-4-5:low");
  assert.equal(def.fastModel, "anthropic/claude-haiku-4-5:low");
  assert.equal(def.smartModel, "anthropic/claude-sonnet-4-5:high");

  const fast = resolveModels({ tier: "fast", env: {}, piqConfig: {}, piSettings, piModels: {} });
  assert.equal(fast.selectedModel, "anthropic/claude-haiku-4-5:low");

  const smart = resolveModels({ tier: "smart", env: {}, piqConfig: {}, piSettings, piModels: {} });
  assert.equal(smart.selectedModel, "anthropic/claude-sonnet-4-5:high");

  const envOver = resolveModels({
    tier: "default",
    env: { PIQ_MODEL: "openai/gpt-5:minimal" },
    piqConfig: { model: "google/gemini-2.5-pro:low" },
    piSettings,
    piModels: {},
  });
  assert.equal(envOver.selectedModel, "openai/gpt-5:minimal");
  assert.deepEqual(splitModelSpec("vertex-maas/deepseek-ai/deepseek-r1:low"), {
    full: "vertex-maas/deepseek-ai/deepseek-r1:low",
    baseModel: "vertex-maas/deepseek-ai/deepseek-r1",
    provider: "vertex-maas",
    modelId: "deepseek-ai/deepseek-r1",
    thinking: "low",
  });
});

test("resolveRequiredExtensions skips built-in and models.json providers, loads matching settings packages", () => {
  const piSettings = {
    packages: ["npm:@twogiants/pi-anthropic-vertex", { source: "npm:pi-acme-provider" }],
  };
  const piModels = {
    providers: {
      "my-local-vllm": { models: [{ id: "qwen" }] },
    },
  };

  // Built-in anthropic must NOT trigger anthropic-vertex extension
  assert.deepEqual(
    resolveRequiredExtensions({ baseModel: "anthropic/claude-sonnet-4-5", env: {}, piqConfig: {}, piSettings, piModels }),
    []
  );
  // models.json custom provider needs no extension
  assert.deepEqual(
    resolveRequiredExtensions({ baseModel: "my-local-vllm/qwen", env: {}, piqConfig: {}, piSettings, piModels }),
    []
  );
  // Extension-backed provider resolves matching package
  assert.deepEqual(
    resolveRequiredExtensions({ baseModel: "anthropic-vertex/claude-sonnet-4-5", env: {}, piqConfig: {}, piSettings, piModels }),
    ["npm:@twogiants/pi-anthropic-vertex"]
  );
  assert.deepEqual(
    resolveRequiredExtensions({ baseModel: "acme-provider/m1", env: {}, piqConfig: {}, piSettings, piModels }),
    ["npm:pi-acme-provider"]
  );
});

test("history parsers handle plain + extended zsh, bash, fish, and redact secrets", () => {
  const redact = createRedactor({
    CUSTOM_API_TOKEN: "supersecretvalue999",
  });
  const now = 1_760_000_060_000;

  const zshSample = [
    "git status",
    ": 1760000000:3;curl -H 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9' \\",
    "https://example.com?k=supersecretvalue999",
    ": 1760000050:0;piq what just ran",
    "OPENAI_API_KEY=sk-proj-1234567890abcdefghijkl node app.js",
  ].join("\n");

  const zshLines = parseZshHistory(zshSample, now, redact);
  assert.equal(zshLines.length, 3);
  assert.match(zshLines[0], /\[recent\] \$ git status/);
  assert.match(zshLines[1], /\[1m ago \| 3\.0s\] \$ curl .*Bearer \[REDACTED\].*\[REDACTED\]/);
  assert.doesNotMatch(zshLines.join("\n"), /supersecretvalue999|eyJhbGci|sk-proj-/);
  assert.match(zshLines[2], /OPENAI_API_KEY=\[REDACTED\]/);

  const bashSample = ["#1760000030", "pytest -q", "ls -la", "piq fix it"].join("\n");
  const bashLines = parseBashHistory(bashSample, now, redact);
  assert.equal(bashLines.length, 2);
  assert.match(bashLines[0], /\[30s ago\] \$ pytest -q/);
  assert.match(bashLines[1], /\[recent\] \$ ls -la/);

  const fishSample = [
    "- cmd: cargo test --lib",
    "  when: 1760000040",
    "- cmd: piq explain",
    "  when: 1760000055",
  ].join("\n");
  const fishLines = parseFishHistory(fishSample, now, redact);
  assert.equal(fishLines.length, 1);
  assert.match(fishLines[0], /\[20s ago\] \$ cargo test --lib/);
});

test("getStandardShellHistory falls back cleanly without Atuin", () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "piq-hist-"));
  try {
    fs.writeFileSync(path.join(tmpHome, ".bash_history"), "echo one\nmake build\n", "utf8");
    const res = getStandardShellHistory({
      env: { SHELL: "/bin/bash" },
      homeDir: tmpHome,
      redact: (s) => s,
    });
    assert.match(res.source, /bash_history/);
    assert.equal(res.lines.length, 2);
    assert.match(res.lines[1], /\$ make build/);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("readPaneHookHistory parses exit codes + cwd trail and rejects symlinks", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "piq-pane-"));
  try {
    const logFile = path.join(tmpDir, "pane-123.tsv");
    const now = Date.now();
    const content = [
      `${now - 10_000}\t120\t0\t${tmpDir}/a\tls -la`,
      `${now - 2_000}\t450\t2\t${tmpDir}/b\tpytest tests/unit`,
      `${now - 1_000}\t10\t0\t${tmpDir}/b\tpiq why did pytest fail`,
    ].join("\n");
    fs.writeFileSync(logFile, content + "\n", { mode: 0o600 });

    const parsed = readPaneHookHistory({
      paneLogPath: logFile,
      nowMs: now,
      homeDir: tmpDir,
      cwd: `${tmpDir}/b`,
      redact: (s) => s,
    });
    assert.ok(parsed);
    assert.equal(parsed.source, "piq-shell-hook");
    assert.equal(parsed.cwdTrail, "~/a -> ~/b");
    assert.equal(parsed.historyLines.length, 2);
    assert.match(parsed.historyLines[0], /exit=0 \| 0\.1s\] \$ ls -la/);
    assert.match(parsed.historyLines[1], /exit=2 \[FAILED\] \| 0\.5s\] \$ pytest tests\/unit/);

    const symPath = path.join(tmpDir, "symlink.tsv");
    fs.symlinkSync(logFile, symPath);
    const symParsed = readPaneHookHistory({
      paneLogPath: symPath,
      nowMs: now,
      homeDir: tmpDir,
      cwd: tmpDir,
      redact: (s) => s,
    });
    assert.equal(symParsed, null);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("renderShellInit produces valid zsh and bash hooks", () => {
  const zshScript = renderShellInit("zsh");
  const bashScript = renderShellInit("bash");
  const fishScript = renderShellInit("fish");
  assert.match(zshScript, /PIQ_PANE_LOG/);
  assert.match(zshScript, /ZSH_SUBSHELL == 0/);
  assert.match(bashScript, /PIQ_PANE_LOG/);
  assert.match(bashScript, /BASH_SUBSHELL/);
  assert.match(fishScript, /PIQ_PANE_LOG/);

  // Syntax-check bash and zsh scripts if shells exist on host
  const bashCheck = spawnSync("bash", ["-n"], { input: bashScript, encoding: "utf8" });
  if (!bashCheck.error) {
    assert.equal(bashCheck.status, 0, bashCheck.stderr);
  }
  const zshCheck = spawnSync("zsh", ["-n"], { input: zshScript, encoding: "utf8" });
  if (!zshCheck.error) {
    assert.equal(zshCheck.status, 0, zshCheck.stderr);
  }
});

test("stream processor routes text to stdout, tools to stderr, and aborts repeated policy blocks", () => {
  let out = "";
  let err = "";
  let aborted = 0;

  const proc = createStreamProcessor({
    stdout: { write: (s) => (out += s) },
    stderr: { write: (s) => (err += s), isTTY: false },
    quiet: false,
    verbose: false,
    isTTYErr: false,
    onAbortChild: () => {
      aborted += 1;
    },
  });

  proc.feedStdoutChunk(
    [
      JSON.stringify({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "du -sh *" } }),
      JSON.stringify({ type: "tool_execution_end", toolCallId: "t1", durationMs: 1250, isError: false }),
      JSON.stringify({ type: "message_start", message: { role: "assistant" } }),
      JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "4.2G build/" } }),
      JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "end_turn" } }),
    ].join("\n") + "\n"
  );

  const code = proc.finalize(0);
  assert.equal(code, 0);
  assert.equal(out, "4.2G build/\n");
  assert.match(err, /▸ \$ du -sh \*/);
  assert.match(err, /✓ 1\.3s/);

  // Test 0-token finish-reason safety block classification + abort on retry 2
  const cls = classifyError("Google Vertex stream ended without a finish reason", {
    contentLen: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  });
  assert.equal(cls.isLikelyFilter, true);

  let err2 = "";
  const proc2 = createStreamProcessor({
    stdout: { write: () => {} },
    stderr: { write: (s) => (err2 += s), isTTY: false },
    isTTYErr: false,
    onAbortChild: () => {
      aborted += 1;
    },
  });
  proc2.handleEvent({
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "error",
      errorMessage: "Google Vertex stream ended without a finish reason",
      content: [],
      usage: { input: 0, output: 0, totalTokens: 0 },
    },
  });
  proc2.handleEvent({ type: "auto_retry_start", attempt: 1, maxAttempts: 5, delayMs: 10000 });
  assert.equal(aborted, 0);
  proc2.handleEvent({ type: "auto_retry_start", attempt: 2, maxAttempts: 5, delayMs: 20000 });
  assert.equal(aborted, 1);
  assert.equal(proc2.finalize(null), 1);
  assert.match(err2, /aborting retries after repeated empty\/policy block/);
});

test("bin/piq.js E2E against mock pi binary via symlink + install.sh --local", () => {
  fs.chmodSync(BIN_PATH, 0o755);
  fs.chmodSync(path.join(REPO_ROOT, "install.sh"), 0o755);

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "piq-e2e-"));
  try {
    const mockPi = path.join(tmpRoot, "mock-pi");
    fs.writeFileSync(
      mockPi,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
let stdinData = "";
if (!process.stdin.isTTY) {
  try { stdinData = require("fs").readFileSync(0, "utf8").trim(); } catch {}
}
const toolsIdx = args.indexOf("--tools");
const tools = toolsIdx !== -1 ? args[toolsIdx + 1] : "";
const modelIdx = args.indexOf("--model");
const model = modelIdx !== -1 ? args[modelIdx + 1] : "default";
const reply = JSON.stringify({ tools, model, stdinData, tail: args.slice(-2) });
process.stdout.write(JSON.stringify({ type: "message_start", message: { role: "assistant" } }) + "\\n");
process.stdout.write(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: reply } }) + "\\n");
process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "end_turn" } }) + "\\n");
`,
      { mode: 0o755 }
    );

    const shareDir = path.join(tmpRoot, "share");
    const binDir = path.join(tmpRoot, "bin");
    execFileSync("sh", [path.join(REPO_ROOT, "install.sh"), "--local"], {
      env: { ...process.env, PIQ_INSTALL_DIR: shareDir, PIQ_BIN_DIR: binDir },
      stdio: "pipe",
    });

    const installedPiq = path.join(binDir, "piq");
    const res = spawnSync(installedPiq, ["-n0q", "-m", "openai/gpt-5:low", "summarize", "diff"], {
      input: "diff --git a/x b/x\n",
      encoding: "utf8",
      env: {
        ...process.env,
        PIQ_PI_BIN: mockPi,
        PIQ_CONFIG: path.join(tmpRoot, "none.json"),
        PI_CODING_AGENT_DIR: path.join(tmpRoot, "pi-agent"),
      },
    });

    assert.equal(res.status, 0, res.stderr);
    const parsedOut = JSON.parse(res.stdout.trim());
    assert.equal(parsedOut.tools, "read,ls,find,grep");
    assert.equal(parsedOut.model, "openai/gpt-5:low");
    assert.equal(parsedOut.stdinData, "diff --git a/x b/x");
    assert.deepEqual(parsedOut.tail, ["--", "summarize diff"]);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
