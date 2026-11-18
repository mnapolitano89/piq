"use strict";

const fs = require("node:fs");
const { UNTRUSTED_CONTEXT_RULE } = require("./context");

function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Plan `piq --attach`: fork the saved piq session into the user's normal interactive pi.
 *
 * - Full pi: none of piq's restrictions (--no-extensions, --tools, ...) are passed; only the
 *   untrusted-context rule is appended, because the forked history contains the attachment.
 * - Model: -m beats -s beats the model the piq call used; omitted if unknown.
 * - Runs in the call's original cwd, falling back to the current one if it is gone.
 */
function planAttach({ sessionFile, sessionInfo, parsed, resolved, currentCwd = process.cwd(), dirExists = isDirectory }) {
  const notes = [];
  let model = sessionInfo.model;
  if (parsed.tier === "explicit" && parsed.explicitModel) {
    model = parsed.explicitModel;
  } else if (parsed.tier === "smart" && resolved.models.smartModel) {
    model = resolved.models.smartModel;
  }

  let cwd = currentCwd;
  if (sessionInfo.cwd) {
    if (dirExists(sessionInfo.cwd)) {
      cwd = sessionInfo.cwd;
    } else {
      notes.push(`${sessionInfo.cwd} no longer exists; attaching in ${currentCwd}`);
    }
  }

  const piArgs = ["--fork", sessionFile, "--append-system-prompt", UNTRUSTED_CONTEXT_RULE];
  if (model) {
    piArgs.push("--model", model);
  }
  return { piArgs, cwd, notes };
}

module.exports = {
  planAttach,
};
