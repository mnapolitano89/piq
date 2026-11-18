"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/**
 * Saved piq sessions, so `piq --attach` can continue the last call in interactive pi.
 *
 * Layout under ${XDG_STATE_HOME:-~/.local/state}/piq (both dirs 0700):
 *   sessions/<iso-timestamp>-<piq pid>.jsonl   pi session files (pi --session <file>)
 *   last-session                               basename of the most recently finished run
 *
 * Only the pointer target survives pruning, plus files of piq runs still in progress
 * (identified by the pid in the name), so concurrent panes never delete each other's runs.
 */

const POINTER_NAME = "last-session";
const SESSION_NAME_RE = /^[0-9TZ-]+-(\d+)\.jsonl$/;

function getStateDir(env = process.env, homeDir = os.homedir()) {
  const base = env.XDG_STATE_HOME || path.join(homeDir, ".local", "state");
  return path.join(base, "piq");
}

function currentUid() {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

/** Create (if needed) and verify a private directory. Returns an error reason or "". */
function ensurePrivateDir(dir, uid) {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (err) {
    return `cannot create ${dir}: ${err.code || err.message}`;
  }
  let st = fs.lstatSync(dir);
  if (st.isSymbolicLink()) return `${dir} is a symlink`;
  if (!st.isDirectory()) return `${dir} is not a directory`;
  if (uid !== null && st.uid !== uid) return `${dir} is owned by another user`;
  if ((st.mode & 0o777) !== 0o700) {
    try {
      fs.chmodSync(dir, 0o700);
    } catch (err) {
      return `cannot chmod ${dir}: ${err.code || err.message}`;
    }
    st = fs.lstatSync(dir);
    if ((st.mode & 0o077) !== 0) return `${dir} is accessible to other users`;
  }
  return "";
}

function ensureStateDirs(stateDir, { uid = currentUid() } = {}) {
  const sessionsDir = path.join(stateDir, "sessions");
  const reason = ensurePrivateDir(stateDir, uid) || ensurePrivateDir(sessionsDir, uid);
  return reason ? { ok: false, reason } : { ok: true, sessionsDir };
}

function newSessionPath(sessionsDir, { now = new Date(), pid = process.pid } = {}) {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return path.join(sessionsDir, `${stamp}-${pid}.jsonl`);
}

function pidFromSessionName(name) {
  const m = SESSION_NAME_RE.exec(name);
  return m ? Number(m[1]) : null;
}

/** Point last-session at sessionPath (atomic rename). No-op if pi never created the file. */
function recordLastSession(stateDir, sessionPath, { pid = process.pid } = {}) {
  if (!sessionPath || !fs.existsSync(sessionPath)) return false;
  const tmp = path.join(stateDir, `${POINTER_NAME}.${pid}.tmp`);
  try {
    fs.writeFileSync(tmp, `${path.basename(sessionPath)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, path.join(stateDir, POINTER_NAME));
    return true;
  } catch {
    fs.rmSync(tmp, { force: true });
    return false;
  }
}

function readLastSession(stateDir) {
  let name;
  try {
    name = fs.readFileSync(path.join(stateDir, POINTER_NAME), "utf8").trim();
  } catch {
    return null;
  }
  if (!name || name !== path.basename(name) || !name.endsWith(".jsonl")) return null;
  const file = path.join(stateDir, "sessions", name);
  return fs.existsSync(file) ? file : null;
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

/** Delete saved sessions except the last-session target and runs still in progress. */
function pruneSessions(stateDir, { isAlive = isPidAlive } = {}) {
  const sessionsDir = path.join(stateDir, "sessions");
  const last = readLastSession(stateDir);
  const keep = last ? path.basename(last) : "";
  const deleted = [];
  let names = [];
  try {
    names = fs.readdirSync(sessionsDir);
  } catch {
    return deleted;
  }
  for (const name of names) {
    const pid = pidFromSessionName(name);
    if (pid === null || name === keep || isAlive(pid)) continue;
    try {
      fs.rmSync(path.join(sessionsDir, name), { force: true });
      deleted.push(name);
    } catch {
      // best effort
    }
  }
  return deleted;
}

/** Working directory and model ("provider/id[:thinking]") recorded in a pi session file. */
function readSessionInfo(file) {
  const info = { cwd: "", model: "" };
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return info;
  }
  let provider = "";
  let modelId = "";
  let thinking = "";
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type === "session" && typeof entry.cwd === "string" && !info.cwd) {
      info.cwd = entry.cwd;
    } else if (entry.type === "model_change" && entry.provider && entry.modelId) {
      provider = entry.provider;
      modelId = entry.modelId;
    } else if (entry.type === "thinking_level_change" && entry.thinkingLevel) {
      thinking = entry.thinkingLevel;
    }
  }
  if (provider && modelId) {
    info.model = `${provider}/${modelId}${thinking ? `:${thinking}` : ""}`;
  }
  return info;
}

module.exports = {
  getStateDir,
  ensureStateDirs,
  newSessionPath,
  pidFromSessionName,
  recordLastSession,
  readLastSession,
  pruneSessions,
  isPidAlive,
  readSessionInfo,
};
