"use strict";

const { execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SECRET_KEY_RE = /(?:^|_)(?:TOKEN|PASSWORD|PASSWD|SECRET|API_KEY|PRIVATE_KEY|PAT|AUTH_TOKEN|ACCESS_KEY|SESSION_TOKEN)$/i;
const KNOWN_TOKEN_PREFIX_RE =
  /\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_\-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_\-]{16,}|xox[baprs]-[A-Za-z0-9\-]{16,}|AKIA[0-9A-Z]{16})\b/g;

function createRedactor(env = process.env) {
  const literalSecrets = [];
  for (const [k, v] of Object.entries(env || {})) {
    if (!SECRET_KEY_RE.test(k)) continue;
    if (typeof v !== "string" || v.length < 8) continue;
    if ((v.startsWith("/") || v.startsWith("~/")) && fs.existsSync(v)) continue;
    literalSecrets.push(v);
  }
  literalSecrets.sort((a, b) => b.length - a.length);

  return function redactSecrets(text) {
    if (!text) return "";
    let out = String(text);
    for (const s of literalSecrets) {
      if (out.includes(s)) {
        out = out.split(s).join("[REDACTED]");
      }
    }
    out = out.replace(KNOWN_TOKEN_PREFIX_RE, "[REDACTED]");
    out = out.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._\-+/=]{8,}/gi, "$1 [REDACTED]");
    out = out.replace(
      /((?:TOKEN|PASSWORD|SECRET|API_KEY|PAT|PASSWD)\s*[:=]\s*)(['"]?)[^\s'"]+(['"]?)/gi,
      "$1$2[REDACTED]$3"
    );
    out = out.replace(
      /(AUTHORIZATION\s*[:=]\s*)(['"]?)(?!(?:Bearer|Basic)\s*\[REDACTED\])[^\s'"]+(['"]?)/gi,
      "$1$2[REDACTED]$3"
    );
    return out;
  };
}

function tildePath(p, homeDir = os.homedir()) {
  if (!p) return "";
  return p === homeDir ? "~" : p.startsWith(homeDir + path.sep) ? "~" + p.slice(homeDir.length) : p;
}

function formatAge(msAgo) {
  if (!Number.isFinite(msAgo) || msAgo < 0) return "";
  const s = Math.round(msAgo / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)}GB`;
}

function isPiqCommand(cmd) {
  if (!cmd) return true;
  const trimmed = String(cmd).trim();
  if (!trimmed) return true;
  return /^(?:\S*\/)?piq(?:\s|$)/.test(trimmed);
}

function runExec(cmd, args, timeoutMs = 450) {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { timeout: timeoutMs, maxBuffer: 512 * 1024, encoding: "utf8" },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          code: err && typeof err.code === "number" ? err.code : 0,
          stdout: stdout || "",
          stderr: stderr || "",
        });
      }
    );
  });
}

function readTailUtf8(filePath, maxBytes = 16384) {
  const st = fs.statSync(filePath);
  if (!st.isFile() || st.size <= 0) return "";
  const readSize = Math.min(st.size, maxBytes);
  const offset = st.size - readSize;
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(readSize);
    fs.readSync(fd, buf, 0, readSize, offset);
    let text = buf.toString("utf8");
    // Drop partial leading line when reading mid-file
    if (offset > 0) {
      const nl = text.indexOf("\n");
      if (nl !== -1) text = text.slice(nl + 1);
    }
    return text;
  } finally {
    fs.closeSync(fd);
  }
}

function formatHistoryLine({ tag = "", age = "", cwdShort = "", exitStr = "", durStr = "", command = "", redact }) {
  const cleanCmd = redact(String(command || "").replace(/\s+/g, " ").trim().slice(0, 240));
  const meta = [tag, age || "recent", cwdShort, exitStr, durStr].filter(Boolean).join(" | ");
  return `  [${meta}] $ ${cleanCmd}`;
}

function parseZshHistory(text, nowMs, redact) {
  if (!text) return [];
  const rawLines = text.split(/\r?\n/);
  // Join backslash-continued lines
  const joined = [];
  let acc = "";
  for (const l of rawLines) {
    if (acc) {
      if (l.endsWith("\\") && !l.endsWith("\\\\")) {
        acc += " " + l.slice(0, -1);
      } else {
        joined.push(acc + " " + l);
        acc = "";
      }
    } else if (l.endsWith("\\") && !l.endsWith("\\\\")) {
      acc = l.slice(0, -1);
    } else {
      joined.push(l);
    }
  }
  if (acc) joined.push(acc);

  const entries = [];
  for (const line of joined) {
    if (!line.trim()) continue;
    const ext = /^:\s*(\d+):(\d+);(.*)$/.exec(line);
    if (ext) {
      const cmd = ext[3].trim();
      if (isPiqCommand(cmd)) continue;
      const tsMs = Number(ext[1]) * 1000;
      const durS = Number(ext[2]);
      entries.push({
        age: tsMs > 0 ? formatAge(nowMs - tsMs) : "",
        durStr: durS > 0 ? `${durS.toFixed(1)}s` : "",
        command: cmd,
      });
    } else {
      const cmd = line.trim();
      if (isPiqCommand(cmd)) continue;
      entries.push({ age: "", durStr: "", command: cmd });
    }
  }

  return entries.slice(-10).map((e) =>
    formatHistoryLine({
      age: e.age,
      durStr: e.durStr,
      command: e.command,
      redact,
    })
  );
}

function parseBashHistory(text, nowMs, redact) {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  const entries = [];
  let pendingTsMs = 0;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const tsMatch = /^#(\d{9,12})$/.exec(line);
    if (tsMatch) {
      pendingTsMs = Number(tsMatch[1]) * 1000;
      continue;
    }
    if (!isPiqCommand(line)) {
      entries.push({
        age: pendingTsMs > 0 ? formatAge(nowMs - pendingTsMs) : "",
        command: line,
      });
    }
    pendingTsMs = 0;
  }

  return entries.slice(-10).map((e) =>
    formatHistoryLine({
      age: e.age,
      command: e.command,
      redact,
    })
  );
}

function parseFishHistory(text, nowMs, redact) {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  const entries = [];
  let current = null;

  for (const line of lines) {
    if (line.startsWith("- cmd: ")) {
      if (current && !isPiqCommand(current.cmd)) {
        entries.push(current);
      }
      const cmd = line
        .slice("- cmd: ".length)
        .replace(/\\n/g, "; ")
        .replace(/\\\\/g, "\\")
        .trim();
      current = { cmd, tsMs: 0 };
    } else if (current && /^\s+when:\s*(\d+)/.test(line)) {
      const m = /^\s+when:\s*(\d+)/.exec(line);
      current.tsMs = Number(m[1]) * 1000;
    }
  }
  if (current && !isPiqCommand(current.cmd)) {
    entries.push(current);
  }

  return entries.slice(-10).map((e) =>
    formatHistoryLine({
      age: e.tsMs > 0 ? formatAge(nowMs - e.tsMs) : "",
      command: e.cmd,
      redact,
    })
  );
}

function getStandardShellHistory({ env = process.env, homeDir = os.homedir(), nowMs = Date.now(), redact }) {
  const shellName = path.basename(env.SHELL || "").toLowerCase();
  const zdotdir = env.ZDOTDIR || homeDir;
  const xdgData = env.XDG_DATA_HOME || path.join(homeDir, ".local", "share");

  const candidates = [];
  const pushCandidate = (filePath, kind) => {
    if (!filePath) return;
    if (!candidates.some((c) => c.filePath === filePath)) {
      candidates.push({ filePath, kind });
    }
  };

  if (env.HISTFILE) {
    const lower = env.HISTFILE.toLowerCase();
    const kind = lower.includes("zsh") || shellName === "zsh" ? "zsh" : "bash";
    pushCandidate(env.HISTFILE, kind);
  }

  if (shellName === "fish") {
    pushCandidate(path.join(xdgData, "fish", "fish_history"), "fish");
  } else if (shellName === "bash") {
    pushCandidate(path.join(homeDir, ".bash_history"), "bash");
  } else if (shellName === "zsh") {
    pushCandidate(path.join(zdotdir, ".zsh_history"), "zsh");
  }

  // Remaining fallbacks
  pushCandidate(path.join(zdotdir, ".zsh_history"), "zsh");
  pushCandidate(path.join(homeDir, ".zsh_history"), "zsh");
  pushCandidate(path.join(homeDir, ".bash_history"), "bash");
  pushCandidate(path.join(xdgData, "fish", "fish_history"), "fish");

  for (const { filePath, kind } of candidates) {
    try {
      if (!fs.existsSync(filePath)) continue;
      const tail = readTailUtf8(filePath, 16384);
      if (!tail.trim()) continue;
      const parsed =
        kind === "fish"
          ? parseFishHistory(tail, nowMs, redact)
          : kind === "bash"
            ? parseBashHistory(tail, nowMs, redact)
            : parseZshHistory(tail, nowMs, redact);
      if (parsed.length > 0) {
        return { source: `${kind}_history (${tildePath(filePath, homeDir)})`, lines: parsed };
      }
    } catch {
      // continue to next candidate
    }
  }

  return { source: "none", lines: [] };
}

function readPaneHookHistory({ paneLogPath, nowMs = Date.now(), homeDir = os.homedir(), cwd = process.cwd(), redact }) {
  if (!paneLogPath) return null;
  try {
    const lst = fs.lstatSync(paneLogPath);
    if (lst.isSymbolicLink() || !lst.isFile()) return null;
    if (typeof process.getuid === "function" && lst.uid !== process.getuid()) return null;

    const tail = readTailUtf8(paneLogPath, 16384);
    if (!tail.trim()) return null;

    const rows = [];
    for (const line of tail.split(/\r?\n/)) {
      if (!line) continue;
      const parts = line.split("\t");
      if (parts.length < 5) continue;
      const tsMs = Number(parts[0]);
      const durMs = Number(parts[1]);
      const ec = Number(parts[2]);
      const rowCwd = parts[3];
      const cmd = parts.slice(4).join("\t").trim();
      if (isPiqCommand(cmd)) continue;
      rows.push({ tsMs, durMs, ec, cwd: rowCwd, command: cmd });
    }

    if (rows.length === 0) return null;
    const recent = rows.slice(-12);

    const cwdTrail = [];
    for (const r of recent) {
      if (r.cwd && cwdTrail[cwdTrail.length - 1] !== r.cwd) {
        cwdTrail.push(r.cwd);
      }
    }
    if (cwd && cwdTrail[cwdTrail.length - 1] !== cwd) {
      cwdTrail.push(cwd);
    }

    const lines = recent.map((r) => {
      const age = Number.isFinite(r.tsMs) && r.tsMs > 0 ? formatAge(nowMs - r.tsMs) : "";
      const durStr = Number.isFinite(r.durMs) && r.durMs >= 0 ? `${(r.durMs / 1000).toFixed(1)}s` : "";
      const exitStr = !Number.isFinite(r.ec)
        ? ""
        : r.ec === 0
          ? "exit=0"
          : `exit=${r.ec} [FAILED]`;
      return formatHistoryLine({
        age,
        cwdShort: tildePath(r.cwd, homeDir),
        exitStr,
        durStr,
        command: r.command,
        redact,
      });
    });

    return {
      source: "piq-shell-hook",
      historyLines: lines,
      cwdTrail: cwdTrail.length > 1 ? cwdTrail.slice(-6).map((p) => tildePath(p, homeDir)).join(" -> ") : "",
    };
  } catch {
    return null;
  }
}

function getAtuinDbPath(env = process.env, homeDir = os.homedir()) {
  if (env.PIQ_DISABLE_ATUIN === "1") return "";
  if (env.ATUIN_DB_PATH) return env.ATUIN_DB_PATH;
  const xdgData = env.XDG_DATA_HOME || path.join(homeDir, ".local", "share");
  return path.join(xdgData, "atuin", "history.db");
}

async function getAtuinHistory({ env = process.env, homeDir = os.homedir(), nowMs = Date.now(), cwd = process.cwd(), redact }) {
  const dbPath = getAtuinDbPath(env, homeDir);
  if (!dbPath || !fs.existsSync(dbPath)) return null;

  const rawSession = env.ATUIN_SESSION || "";
  const rawHistId = env.ATUIN_HISTORY_ID || "";
  const session = /^[0-9a-fA-F-]+$/.test(rawSession) ? rawSession : "";
  const histId = /^[0-9a-fA-F-]+$/.test(rawHistId) ? rawHistId : "";

  const sql = session
    ? `
SELECT * FROM (
  SELECT timestamp, duration, exit, command, cwd, 1 AS in_session
  FROM history
  WHERE deleted_at IS NULL
    AND session = '${session}'
    ${histId ? `AND id != '${histId}'` : ""}
    AND NOT (duration < 0 AND (command LIKE 'piq %' OR command LIKE '%/piq %'))
  ORDER BY timestamp DESC
  LIMIT 12
)
UNION ALL
SELECT * FROM (
  SELECT timestamp, duration, exit, command, cwd, 0 AS in_session
  FROM history
  WHERE deleted_at IS NULL
    AND session != '${session}'
    ${histId ? `AND id != '${histId}'` : ""}
    AND NOT (duration < 0 AND (command LIKE 'piq %' OR command LIKE '%/piq %'))
  ORDER BY timestamp DESC
  LIMIT 6
);`
    : `
SELECT timestamp, duration, exit, command, cwd, 1 AS in_session
FROM history
WHERE deleted_at IS NULL
  ${histId ? `AND id != '${histId}'` : ""}
  AND NOT (duration < 0 AND (command LIKE 'piq %' OR command LIKE '%/piq %'))
ORDER BY timestamp DESC
LIMIT 12;`;

  const res = await runExec("sqlite3", ["-readonly", "-cmd", ".timeout 150", "-json", dbPath, sql], 350);
  if (!res.ok || !res.stdout.trim()) return null;

  try {
    const rows = JSON.parse(res.stdout);
    if (!Array.isArray(rows) || rows.length === 0) return null;

    const sessionRows = rows.filter((r) => r.in_session === 1 && !isPiqCommand(r.command)).reverse();
    const otherRows = rows.filter((r) => r.in_session === 0 && !isPiqCommand(r.command)).reverse();
    if (sessionRows.length === 0 && otherRows.length === 0) return null;

    const cwdTrail = [];
    for (const r of sessionRows) {
      if (r.cwd && cwdTrail[cwdTrail.length - 1] !== r.cwd) {
        cwdTrail.push(r.cwd);
      }
    }
    if (cwd && cwdTrail[cwdTrail.length - 1] !== cwd) {
      cwdTrail.push(cwd);
    }

    const formatRow = (r, tag = "") => {
      const tsMs = Number(r.timestamp) / 1e6;
      const age = formatAge(nowMs - tsMs);
      const durS = Number(r.duration) >= 0 ? `${(Number(r.duration) / 1e9).toFixed(1)}s` : "running";
      const exitStr =
        Number(r.exit) < 0 ? "in-flight" : Number(r.exit) === 0 ? "exit=0" : `exit=${r.exit} [FAILED]`;
      return formatHistoryLine({
        tag,
        age,
        cwdShort: tildePath(r.cwd, homeDir),
        exitStr,
        durStr: durS,
        command: r.command,
        redact,
      });
    };

    const lines = [];
    if (sessionRows.length < 4 && otherRows.length > 0) {
      for (const r of otherRows.slice(-(6 - sessionRows.length))) {
        lines.push(formatRow(r, "other-pane"));
      }
    }
    for (const r of sessionRows) {
      lines.push(formatRow(r));
    }

    return {
      source: "atuin",
      historyLines: lines,
      cwdTrail: cwdTrail.length > 1 ? cwdTrail.slice(-6).map((p) => tildePath(p, homeDir)).join(" -> ") : "",
    };
  } catch {
    return null;
  }
}

async function getShellHistoryAndTrail({ env = process.env, homeDir = os.homedir(), cwd = process.cwd(), redact } = {}) {
  const redactor = redact || createRedactor(env);
  const nowMs = Date.now();

  // 1. Optional `piq --init` per-pane hook (0 external deps, exact per-pane exit codes + cwd trail)
  const hookRes = readPaneHookHistory({
    paneLogPath: env.PIQ_PANE_LOG,
    nowMs,
    homeDir,
    cwd,
    redact: redactor,
  });
  if (hookRes) {
    return hookRes;
  }

  // 2. Opportunistic Atuin SQLite history (silent auto-detect if installed)
  const atuinRes = await getAtuinHistory({
    env,
    homeDir,
    nowMs,
    cwd,
    redact: redactor,
  });
  if (atuinRes) {
    return atuinRes;
  }

  // 3. Universal zero-config fallback ($HISTFILE / ~/.zsh_history / ~/.bash_history / fish_history)
  const stdRes = getStandardShellHistory({
    env,
    homeDir,
    nowMs,
    redact: redactor,
  });
  return {
    source: stdRes.source,
    historyLines: stdRes.lines,
    cwdTrail: "",
  };
}

function getShallowCwdListing(cwd) {
  try {
    const dirents = fs.readdirSync(cwd, { withFileTypes: true }).filter((d) => d.name !== ".DS_Store");
    const total = dirents.length;
    const inspected = [];
    const cap = Math.min(total, 60);
    for (let i = 0; i < cap; i++) {
      const d = dirents[i];
      let mtimeMs = 0;
      let size = 0;
      let isDir = d.isDirectory();
      try {
        const st = fs.statSync(path.join(cwd, d.name));
        mtimeMs = st.mtimeMs;
        size = st.size;
        isDir = st.isDirectory();
      } catch {
        // broken symlink or race
      }
      inspected.push({ name: d.name, isDir, mtimeMs, size });
    }
    inspected.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const now = Date.now();
    const shown = inspected.slice(0, 35).map((item) => {
      const age = item.mtimeMs ? formatAge(now - item.mtimeMs) : "";
      if (item.isDir) {
        return `${item.name}/${age ? ` (${age})` : ""}`;
      }
      const sz = formatBytes(item.size);
      return `${item.name} (${[sz, age].filter(Boolean).join(", ")})`;
    });
    if (total > shown.length) {
      shown.push(`... (+${total - shown.length} more entries)`);
    }
    return shown.join(", ");
  } catch {
    return "";
  }
}

async function getGitContext(cwd = process.cwd()) {
  const res = await runExec("git", ["-C", cwd, "status", "--short", "--branch", "--untracked-files=normal"], 300);
  if (!res.ok || !res.stdout.trim()) return "";
  const lines = res.stdout.trimEnd().split("\n");
  if (lines.length > 16) {
    return [...lines.slice(0, 16), `... (+${lines.length - 16} more paths)`].join("\n");
  }
  return lines.join("\n");
}

async function getTerminalScrollback({ env = process.env, homeDir = os.homedir(), redact } = {}) {
  const redactor = redact || createRedactor(env);
  let raw = "";

  if (env.TMUX && env.TMUX_PANE) {
    const res = await runExec("tmux", ["capture-pane", "-p", "-t", env.TMUX_PANE, "-S", "-80"], 350);
    if (res.ok) raw = res.stdout;
  } else if (env.WEZTERM_PANE) {
    const res = await runExec("wezterm", ["cli", "get-text", "--pane-id", env.WEZTERM_PANE, "--start-line", "-80"], 350);
    if (res.ok) raw = res.stdout;
  } else if (env.KITTY_WINDOW_ID && env.KITTY_LISTEN_ON) {
    const res = await runExec(
      "kitty",
      ["@", "--to", env.KITTY_LISTEN_ON, "get-text", "--match", `id:${env.KITTY_WINDOW_ID}`, "--extent", "screen"],
      350
    );
    if (res.ok) raw = res.stdout;
  } else if (env.ITERM_SESSION_ID) {
    const it2Candidates = [
      "/Applications/iTerm.app/Contents/Resources/utilities/it2",
      path.join(homeDir, "Applications/iTerm.app/Contents/Resources/utilities/it2"),
    ];
    const it2Bin = it2Candidates.find((p) => fs.existsSync(p));
    if (it2Bin) {
      const parts = env.ITERM_SESSION_ID.split(":");
      const sid = parts[parts.length - 1];
      let res = sid ? await runExec(it2Bin, ["session", "read", "--session", sid, "--lines", "80"], 400) : { ok: false };
      if (!res.ok) {
        // Fallback when ITERM_SESSION_ID has a stale pre-restart UUID
        res = await runExec(it2Bin, ["session", "read", "--lines", "80"], 350);
      }
      if (res.ok) raw = res.stdout;
    }
  }

  if (!raw) return "";

  const noAnsi = raw.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
  const lines = noAnsi.split(/\r?\n/).map((l) => l.trimEnd());
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  const compacted = [];
  let prevEmpty = false;
  for (const l of lines) {
    if (l === "") {
      if (!prevEmpty && compacted.length > 0) compacted.push("");
      prevEmpty = true;
    } else {
      compacted.push(l);
      prevEmpty = false;
    }
  }

  let tail = compacted.slice(-55).join("\n");
  if (tail.length > 3800) {
    tail = "...\n" + tail.slice(-3800);
  }
  return redactor(tail);
}

function findAvailableCliTools(toolNames, env = process.env) {
  const dirs = String(env.PATH || "").split(path.delimiter).filter(Boolean);
  const found = [];
  for (const name of toolNames) {
    const bin = process.platform === "win32" ? `${name}.exe` : name;
    for (const dir of dirs) {
      try {
        fs.accessSync(path.join(dir, bin), fs.constants.X_OK);
        found.push(name);
        break;
      } catch {
        // not in this dir
      }
    }
  }
  return found;
}

function getPlatformInfo(env = process.env) {
  const shell = path.basename(env.SHELL || "") || "sh";
  const fastTools = findAvailableCliTools(["rg", "fd", "pigz", "zstd", "jq", "eza"], env);
  return {
    platform: os.platform(),
    arch: os.arch(),
    shell,
    fastTools,
  };
}

function detectContextCapabilities({ env = process.env, homeDir = os.homedir() } = {}) {
  let historySource = "shell history file";
  if (env.PIQ_PANE_LOG && fs.existsSync(env.PIQ_PANE_LOG)) {
    historySource = `piq shell hook (${tildePath(env.PIQ_PANE_LOG, homeDir)})`;
  } else {
    const atuinDb = getAtuinDbPath(env, homeDir);
    if (atuinDb && fs.existsSync(atuinDb)) {
      historySource = `atuin (${tildePath(atuinDb, homeDir)})`;
    } else {
      const std = getStandardShellHistory({
        env,
        homeDir,
        redact: (s) => s,
      });
      historySource = std.source;
    }
  }

  let scrollbackSource = "none";
  if (env.TMUX && env.TMUX_PANE) scrollbackSource = `tmux (${env.TMUX_PANE})`;
  else if (env.WEZTERM_PANE) scrollbackSource = `wezterm (pane ${env.WEZTERM_PANE})`;
  else if (env.KITTY_WINDOW_ID && env.KITTY_LISTEN_ON) scrollbackSource = `kitty (window ${env.KITTY_WINDOW_ID})`;
  else if (env.ITERM_SESSION_ID) {
    const hasIt2 =
      fs.existsSync("/Applications/iTerm.app/Contents/Resources/utilities/it2") ||
      fs.existsSync(path.join(homeDir, "Applications/iTerm.app/Contents/Resources/utilities/it2"));
    scrollbackSource = hasIt2 ? "iterm2 (it2)" : "iterm2 (it2 helper not installed)";
  }

  return { historySource, scrollbackSource };
}

async function buildTerminalContextBlock({ noTermContext = false, cwd = process.cwd(), env = process.env, homeDir = os.homedir() } = {}) {
  if (noTermContext) return "";
  const redact = createRedactor(env);
  const [hist, scrollback, gitStatus] = await Promise.all([
    getShellHistoryAndTrail({ env, homeDir, cwd, redact }),
    getTerminalScrollback({ env, homeDir, redact }),
    getGitContext(cwd),
  ]);
  const shallowLs = getShallowCwdListing(cwd);

  const sections = [];
  const locLines = [`- Current directory: ${cwd} (${tildePath(cwd, homeDir)})`];
  if (hist.cwdTrail) {
    locLines.push(`- Directory trail in this pane: ${hist.cwdTrail}`);
  }
  if (env.OLDPWD && env.OLDPWD !== cwd) {
    locLines.push(`- OLDPWD: ${tildePath(env.OLDPWD, homeDir)}`);
  }
  const activeEnv =
    env.CONDA_DEFAULT_ENV ||
    env.PIXI_ENVIRONMENT_NAME ||
    (env.VIRTUAL_ENV ? path.basename(env.VIRTUAL_ENV) : "");
  if (activeEnv) {
    locLines.push(`- Active Python/Conda env: ${activeEnv}`);
  }
  if (shallowLs) {
    locLines.push(`- CWD entries (newest first): ${shallowLs}`);
  }
  sections.push(`Location & Environment:\n${locLines.join("\n")}`);

  if (gitStatus) {
    sections.push(`Git status:\n${gitStatus}`);
  }

  if (hist.historyLines && hist.historyLines.length > 0) {
    sections.push(`Recent shell commands (oldest -> newest):\n${hist.historyLines.join("\n")}`);
  }

  if (scrollback) {
    sections.push(`Recent terminal pane output (scrollback before this piq invocation):\n\`\`\`text\n${scrollback}\n\`\`\``);
  }

  return sections.join("\n\n");
}

function buildSystemPrompt({ cwd = process.cwd(), dryRun = false, termContext = "", platformInfo = getPlatformInfo() } = {}) {
  const toolsNote =
    platformInfo.fastTools.length > 0
      ? `; available CLI tools: ${platformInfo.fastTools.join(", ")}`
      : "";
  const hasPigz = platformInfo.fastTools.includes("pigz");
  const hasZstd = platformInfo.fastTools.includes("zstd");
  const compressionHint = hasPigz
    ? "prefer parallel compression (e.g. `tar -I pigz -cf archive.tar.gz ...` or `pigz`) over single-threaded gzip"
    : hasZstd
      ? "prefer parallel compression (e.g. `zstd -T0` or `tar --zstd -cf archive.tar.zst ...`) when appropriate"
      : "verify archive integrity before suggesting cleanup";

  return [
    `You are piq, a fast non-interactive CLI utility executing a one-off request in the user's terminal.`,
    `Working directory: ${cwd}`,
    `Platform: ${platformInfo.platform} ${platformInfo.arch} (shell: ${platformInfo.shell}${toolsNote}).`,
    dryRun
      ? `DRY-RUN MODE: You only have read-only tools (read, ls, find, grep). Inspect the directory/files as needed, then output the exact shell command(s) the user should run and a brief explanation. Do not attempt to modify anything.`
      : [
          `Guidelines:`,
          `1. Use the provided terminal context (recent shell commands, exit codes, scrollback output, and cwd listing) immediately when answering questions about what just ran/failed or what files are present, avoiding redundant tool calls when the answer is already visible.`,
          `2. When deeper inspection is needed, use fast read-only commands (ls, du, fd, rg) before acting.`,
          `3. For archiving/compression of large directories, ${compressionHint}.`,
          `4. SAFETY: Never delete original user files/folders (no \`rm -rf\` or \`tar --remove-files\`) unless the user explicitly asked to delete/remove them. When compressing to save space, create and verify the archive first, then print the exact \`rm\` command the user can run to remove the originals.`,
          `5. Be terse and terminal-friendly. State what you did, the resulting paths/sizes, and stop.`,
        ].join("\n"),
    termContext ? `\n--- TERMINAL SESSION CONTEXT ---\n${termContext}\n--- END TERMINAL SESSION CONTEXT ---` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

module.exports = {
  createRedactor,
  tildePath,
  formatAge,
  formatBytes,
  isPiqCommand,
  parseZshHistory,
  parseBashHistory,
  parseFishHistory,
  getStandardShellHistory,
  readPaneHookHistory,
  getAtuinHistory,
  getShellHistoryAndTrail,
  getShallowCwdListing,
  getGitContext,
  getTerminalScrollback,
  findAvailableCliTools,
  getPlatformInfo,
  detectContextCapabilities,
  buildTerminalContextBlock,
  buildSystemPrompt,
};
