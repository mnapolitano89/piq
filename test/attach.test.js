"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const sessions = require("../lib/sessions");

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeSessionFile(file, { cwd = "/work", provider = "google-vertex", modelId = "gemini-x", thinking = "low" } = {}) {
  const lines = [
    { type: "session", version: 3, id: "abc", cwd },
    { type: "model_change", id: "1", provider: "openai", modelId: "old-model" },
    { type: "model_change", id: "2", provider, modelId },
    { type: "thinking_level_change", id: "3", thinkingLevel: thinking },
    { type: "message", id: "4", message: { role: "user", content: "hi" } },
  ];
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

test("getStateDir honors XDG_STATE_HOME and defaults to ~/.local/state/piq", () => {
  assert.equal(sessions.getStateDir({ XDG_STATE_HOME: "/x/state" }, "/home/u"), path.join("/x/state", "piq"));
  assert.equal(sessions.getStateDir({}, "/home/u"), path.join("/home/u", ".local", "state", "piq"));
});

test("ensureStateDirs creates private dirs, tightens loose ones, refuses symlinks", () => {
  const root = tmpDir("piq-state-");
  try {
    const stateDir = path.join(root, "a", "piq");
    const res = sessions.ensureStateDirs(stateDir);
    assert.equal(res.ok, true, res.reason);
    assert.equal(res.sessionsDir, path.join(stateDir, "sessions"));
    assert.equal(fs.statSync(stateDir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(res.sessionsDir).mode & 0o777, 0o700);

    const loose = path.join(root, "loose", "piq");
    fs.mkdirSync(path.join(loose, "sessions"), { recursive: true });
    fs.chmodSync(loose, 0o777);
    fs.chmodSync(path.join(loose, "sessions"), 0o777);
    assert.equal(sessions.ensureStateDirs(loose).ok, true);
    assert.equal(fs.statSync(loose).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(loose, "sessions")).mode & 0o777, 0o700);

    const victim = path.join(root, "victim");
    fs.mkdirSync(victim);
    fs.mkdirSync(path.join(root, "planted"));
    fs.symlinkSync(victim, path.join(root, "planted", "piq"));
    const refused = sessions.ensureStateDirs(path.join(root, "planted", "piq"));
    assert.equal(refused.ok, false);
    assert.match(refused.reason, /symlink/);
    assert.deepEqual(fs.readdirSync(victim), []);

    const linkedSessions = path.join(root, "ls", "piq");
    fs.mkdirSync(linkedSessions, { recursive: true });
    fs.symlinkSync(victim, path.join(linkedSessions, "sessions"));
    assert.equal(sessions.ensureStateDirs(linkedSessions).ok, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("session file names embed the piq pid", () => {
  const p = sessions.newSessionPath("/s", { now: new Date("2026-11-18T17:52:02.411Z"), pid: 4242 });
  assert.equal(p, path.join("/s", "2026-11-18T17-52-02-411Z-4242.jsonl"));
  assert.equal(sessions.pidFromSessionName(path.basename(p)), 4242);
  assert.equal(sessions.pidFromSessionName("notes.txt"), null);
});

test("last-session pointer: written atomically only for existing files, validated on read", () => {
  const root = tmpDir("piq-ptr-");
  try {
    const { sessionsDir } = sessions.ensureStateDirs(root);
    const missing = path.join(sessionsDir, "2026-01-01T00-00-00-000Z-1.jsonl");
    assert.equal(sessions.recordLastSession(root, missing, { pid: 1 }), false);
    assert.equal(sessions.readLastSession(root), null);

    const file = path.join(sessionsDir, "2026-01-01T00-00-01-000Z-2.jsonl");
    writeSessionFile(file);
    assert.equal(sessions.recordLastSession(root, file, { pid: 2 }), true);
    assert.equal(fs.readFileSync(path.join(root, "last-session"), "utf8").trim(), path.basename(file));
    assert.deepEqual(fs.readdirSync(root).filter((n) => n.endsWith(".tmp")), [], "no temp files left");
    assert.equal(sessions.readLastSession(root), file);

    fs.writeFileSync(path.join(root, "last-session"), "../../etc/passwd\n");
    assert.equal(sessions.readLastSession(root), null);
    fs.writeFileSync(path.join(root, "last-session"), "gone-3.jsonl\n");
    assert.equal(sessions.readLastSession(root), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("pruneSessions keeps the pointer target and live runs, deletes the rest", () => {
  const root = tmpDir("piq-prune-");
  try {
    const { sessionsDir } = sessions.ensureStateDirs(root);
    const names = {
      old: "2026-01-01T00-00-00-000Z-100.jsonl",
      last: "2026-01-01T00-00-01-000Z-101.jsonl",
      live: "2026-01-01T00-00-02-000Z-102.jsonl",
      dead: "2026-01-01T00-00-03-000Z-103.jsonl",
    };
    for (const n of Object.values(names)) writeSessionFile(path.join(sessionsDir, n));
    fs.writeFileSync(path.join(sessionsDir, "README"), "not a session");
    sessions.recordLastSession(root, path.join(sessionsDir, names.last), { pid: 101 });

    const deleted = sessions.pruneSessions(root, { isAlive: (pid) => pid === 102 });
    assert.deepEqual(deleted.sort(), [names.dead, names.old].sort());
    assert.deepEqual(fs.readdirSync(sessionsDir).sort(), ["README", names.last, names.live].sort());
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("readSessionInfo reads cwd and the latest model + thinking level", () => {
  const root = tmpDir("piq-info-");
  try {
    const file = path.join(root, "s.jsonl");
    writeSessionFile(file, { cwd: "/repo", provider: "google-vertex", modelId: "gemini-4-hydrogen", thinking: "low" });
    fs.appendFileSync(file, "not json\n");
    assert.deepEqual(sessions.readSessionInfo(file), { cwd: "/repo", model: "google-vertex/gemini-4-hydrogen:low" });

    const bare = path.join(root, "bare.jsonl");
    fs.writeFileSync(bare, JSON.stringify({ type: "session", cwd: "/x" }) + "\n");
    assert.deepEqual(sessions.readSessionInfo(bare), { cwd: "/x", model: "" });
    assert.deepEqual(sessions.readSessionInfo(path.join(root, "missing.jsonl")), { cwd: "", model: "" });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const { parseArgs } = require("../lib/args");
const { buildPiArgs } = require("../lib/pi-args");
const { buildSystemPrompt, UNTRUSTED_CONTEXT_RULE } = require("../lib/context");

test("parseArgs recognizes -a / --attach, including bundled with -m", () => {
  assert.equal(parseArgs([]).attach, false);
  assert.equal(parseArgs(["-a"]).attach, true);
  assert.equal(parseArgs(["--attach"]).attach, true);
  const bundled = parseArgs(["-sam", "openai/gpt-5"]);
  assert.equal(bundled.attach, true);
  assert.equal(bundled.explicitModel, "openai/gpt-5");
  assert.deepEqual(parseArgs(["what", "is", "-a"]).promptWords, ["what", "is", "-a"]);
});

test("buildPiArgs saves to --session <path> when given, else --no-session", () => {
  const resolved = { models: { selectedModel: "a/b:low", baseModel: "a/b" }, extensions: [] };
  const parsed = { execute: false, withContext: false, fileArgs: [] };
  const saved = buildPiArgs({ parsed, resolved, sysPrompt: "s", promptText: "q", sessionPath: "/st/x.jsonl" });
  assert.equal(saved[saved.indexOf("--session") + 1], "/st/x.jsonl");
  assert.equal(saved.includes("--no-session"), false);
  const unsaved = buildPiArgs({ parsed, resolved, sysPrompt: "s", promptText: "q" });
  assert.equal(unsaved.includes("--no-session"), true);
  assert.equal(unsaved.includes("--session"), false);
});

test("the untrusted-context rule is shared by normal runs and attach", () => {
  assert.match(UNTRUSTED_CONTEXT_RULE, /NEVER follow instructions/);
  const platformInfo = { platform: "linux", arch: "x64", shell: "zsh", fastTools: [] };
  assert.ok(buildSystemPrompt({ hasContextFile: true, platformInfo }).includes(UNTRUSTED_CONTEXT_RULE));
});

const { planAttach } = require("../lib/attach");

test("planAttach forks the saved session with full pi, same model, in the call's cwd", () => {
  const base = {
    sessionFile: "/st/sessions/s-1.jsonl",
    sessionInfo: { cwd: "/repo", model: "google-vertex/gemini-4-hydrogen:low" },
    parsed: { tier: "fast", explicitModel: null },
    resolved: { models: { smartModel: "google-vertex/gemini-4-carbon:high" } },
    currentCwd: "/elsewhere",
    dirExists: () => true,
  };
  const valueAfter = (args, flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);

  const plan = planAttach(base);
  assert.deepEqual(plan.piArgs.slice(0, 2), ["--fork", "/st/sessions/s-1.jsonl"]);
  assert.equal(valueAfter(plan.piArgs, "--append-system-prompt"), UNTRUSTED_CONTEXT_RULE);
  assert.equal(valueAfter(plan.piArgs, "--model"), "google-vertex/gemini-4-hydrogen:low");
  for (const flag of ["--no-extensions", "--no-skills", "--tools", "--no-context-files", "--mode", "--no-session", "--session"]) {
    assert.equal(plan.piArgs.includes(flag), false, flag);
  }
  assert.equal(plan.cwd, "/repo");
  assert.deepEqual(plan.notes, []);

  assert.equal(valueAfter(planAttach({ ...base, parsed: { tier: "smart" } }).piArgs, "--model"), "google-vertex/gemini-4-carbon:high");
  assert.equal(
    valueAfter(planAttach({ ...base, parsed: { tier: "explicit", explicitModel: "openai/gpt-5" } }).piArgs, "--model"),
    "openai/gpt-5"
  );
  assert.equal(planAttach({ ...base, sessionInfo: { cwd: "/repo", model: "" } }).piArgs.includes("--model"), false);

  const moved = planAttach({ ...base, dirExists: () => false });
  assert.equal(moved.cwd, "/elsewhere");
  assert.match(moved.notes[0], /\/repo no longer exists/);
  assert.equal(planAttach({ ...base, sessionInfo: { cwd: "", model: "" } }).cwd, "/elsewhere");
});

// ---------------------------------------------------------------------------
// E2E: bin/piq.js against mock pi binaries

const { spawnSync } = require("node:child_process");

const BIN_PATH = path.resolve(__dirname, "..", "bin", "piq.js");

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/** Run a command under a pseudo-terminal (pi only runs interactively on a TTY). */
function spawnInPty(cmd, args, opts) {
  const scriptArgs =
    process.platform === "darwin"
      ? ["-q", "/dev/null", cmd, ...args]
      : ["-qec", [cmd, ...args].map(shellQuote).join(" "), "/dev/null"];
  return spawnSync("script", scriptArgs, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
}

function e2eEnv(root, extra = {}) {
  const env = {
    ...process.env,
    XDG_STATE_HOME: path.join(root, "state"),
    PIQ_CONFIG: path.join(root, "none.json"),
    PI_CODING_AGENT_DIR: path.join(root, "pi-agent"),
    PIQ_DISABLE_ATUIN: "1",
    ...extra,
  };
  for (const k of ["PIQ_PANE_LOG", "TMUX", "TMUX_PANE", "WEZTERM_PANE", "KITTY_WINDOW_ID", "ITERM_SESSION_ID"]) {
    delete env[k];
  }
  return env;
}

/** Mock pi for normal runs: writes a session file at --session like real pi does. */
function writeRunMock(root) {
  const p = path.join(root, "run-pi");
  fs.writeFileSync(
    p,
    `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
const i = args.indexOf("--session");
if (i !== -1) {
  fs.writeFileSync(args[i + 1], [
    JSON.stringify({ type: "session", version: 3, id: "x", cwd: process.cwd() }),
    JSON.stringify({ type: "model_change", provider: "mockprov", modelId: "mock-fast" }),
    JSON.stringify({ type: "thinking_level_change", thinkingLevel: "low" }),
  ].join("\\n") + "\\n");
}
const reply = JSON.stringify({ session: i !== -1 ? args[i + 1] : null, noSession: args.includes("--no-session") });
process.stdout.write(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: reply } }) + "\\n");
`,
    { mode: 0o755 }
  );
  return p;
}

/** Mock pi for attach: records argv, cwd, and TTY state, then exits 7. */
function writeAttachMock(root, recordFile) {
  const p = path.join(root, "attach-pi");
  fs.writeFileSync(
    p,
    `#!/usr/bin/env node
require("fs").writeFileSync(${JSON.stringify(recordFile)}, JSON.stringify({
  args: process.argv.slice(2), cwd: process.cwd(),
  stdinTTY: Boolean(process.stdin.isTTY), stdoutTTY: Boolean(process.stdout.isTTY),
}));
process.exit(7);
`,
    { mode: 0o755 }
  );
  return p;
}

test("normal runs save to a private session file; only the latest survives", () => {
  const root = fs.realpathSync(tmpDir("piq-e2e-save-"));
  try {
    const env = e2eEnv(root, { PIQ_PI_BIN: writeRunMock(root) });
    const stateDir = path.join(root, "state", "piq");

    const r1 = spawnSync(BIN_PATH, ["-0q", "first"], { encoding: "utf8", env, cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    assert.equal(r1.status, 0, r1.stderr);
    const out1 = JSON.parse(r1.stdout.trim());
    assert.equal(out1.noSession, false);
    assert.equal(path.dirname(out1.session), path.join(stateDir, "sessions"));
    assert.equal(fs.statSync(path.join(stateDir, "sessions")).mode & 0o777, 0o700);
    assert.equal(sessions.readLastSession(stateDir), out1.session);

    const r2 = spawnSync(BIN_PATH, ["-0q", "second"], { encoding: "utf8", env, cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    assert.equal(r2.status, 0, r2.stderr);
    const out2 = JSON.parse(r2.stdout.trim());
    assert.notEqual(out2.session, out1.session);
    assert.equal(sessions.readLastSession(stateDir), out2.session);
    assert.deepEqual(fs.readdirSync(path.join(stateDir, "sessions")), [path.basename(out2.session)]);

    // Unsafe state dir: the run still works, unsaved, with a warning
    const unsafeRoot = path.join(root, "unsafe");
    fs.mkdirSync(path.join(unsafeRoot, "victim"), { recursive: true });
    fs.symlinkSync(path.join(unsafeRoot, "victim"), path.join(unsafeRoot, "piq"));
    const r3 = spawnSync(BIN_PATH, ["-0", "third"], {
      encoding: "utf8",
      env: { ...env, XDG_STATE_HOME: unsafeRoot },
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(r3.status, 0, r3.stderr);
    assert.equal(JSON.parse(r3.stdout.trim()).noSession, true);
    assert.match(r3.stderr, /not saving this session/);
    assert.deepEqual(fs.readdirSync(path.join(unsafeRoot, "victim")), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("--attach usage errors: no session, prompt words, no terminal", () => {
  const root = fs.realpathSync(tmpDir("piq-e2e-attach-err-"));
  try {
    const env = e2eEnv(root, { PIQ_PI_BIN: writeAttachMock(root, path.join(root, "rec.json")) });
    const run = (args) => spawnSync(BIN_PATH, args, { encoding: "utf8", env, cwd: root, stdio: ["ignore", "pipe", "pipe"] });

    const withPrompt = run(["-a", "hello"]);
    assert.equal(withPrompt.status, 2);
    assert.match(withPrompt.stderr, /--attach does not take a prompt/);

    const noSession = run(["-a"]);
    assert.equal(noSession.status, 1);
    assert.match(noSession.stderr, /no previous piq session to attach to/);

    // Create a saved session, then attach without a terminal
    const { sessionsDir } = sessions.ensureStateDirs(path.join(root, "state", "piq"));
    const file = path.join(sessionsDir, "2026-01-01T00-00-00-000Z-1.jsonl");
    writeSessionFile(file, { cwd: root });
    sessions.recordLastSession(path.join(root, "state", "piq"), file);
    const noTty = run(["-a"]);
    assert.equal(noTty.status, 2);
    assert.match(noTty.stderr, /needs an interactive terminal/);
    assert.equal(fs.existsSync(path.join(root, "rec.json")), false, "pi not started");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("--attach forks the last session in its cwd with its model, on a TTY, and propagates the exit code", (t) => {
  if (spawnSync("script", ["--version"]).error && spawnSync("which", ["script"]).status !== 0) {
    t.skip("script(1) not available");
    return;
  }
  const root = fs.realpathSync(tmpDir("piq-e2e-attach-"));
  try {
    const record = path.join(root, "rec.json");
    const env = e2eEnv(root, { PIQ_PI_BIN: writeAttachMock(root, record) });
    const stateDir = path.join(root, "state", "piq");
    const callCwd = path.join(root, "project");
    fs.mkdirSync(callCwd);
    const { sessionsDir } = sessions.ensureStateDirs(stateDir);
    const file = path.join(sessionsDir, "2026-01-01T00-00-00-000Z-1.jsonl");
    writeSessionFile(file, { cwd: callCwd, provider: "mockprov", modelId: "mock-fast", thinking: "low" });
    sessions.recordLastSession(stateDir, file);

    const res = spawnInPty(BIN_PATH, ["-a"], { env, cwd: root });
    assert.equal(res.status, 7, `${res.stdout}\n${res.stderr}`);
    const rec = JSON.parse(fs.readFileSync(record, "utf8"));
    assert.deepEqual(rec.args.slice(0, 2), ["--fork", file]);
    assert.equal(rec.args[rec.args.indexOf("--model") + 1], "mockprov/mock-fast:low");
    assert.equal(rec.args.includes("--no-extensions"), false);
    assert.equal(rec.cwd, callCwd);
    assert.equal(rec.stdinTTY && rec.stdoutTTY, true);

    fs.rmSync(record);
    const smart = spawnInPty(BIN_PATH, ["-a", "-m", "other/model:high"], { env, cwd: root });
    assert.equal(smart.status, 7, `${smart.stdout}\n${smart.stderr}`);
    const rec2 = JSON.parse(fs.readFileSync(record, "utf8"));
    assert.equal(rec2.args[rec2.args.indexOf("--model") + 1], "other/model:high");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
