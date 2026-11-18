"use strict";

const path = require("node:path");

const SUPPORTED_SHELLS = new Set(["zsh", "bash", "fish"]);

function detectDefaultShell(env = process.env) {
  const base = path.basename(env.SHELL || "").toLowerCase();
  if (SUPPORTED_SHELLS.has(base)) return base;
  return "zsh";
}

/**
 * Parse CLI arguments for piq.
 * Never intercepts positional words (e.g. `piq init a repo` stays a prompt);
 * only explicit flags (`--init`, `--config`, `-f`, etc.) trigger actions.
 */
function parseArgs(rawArgs, env = process.env) {
  const out = {
    help: false,
    version: false,
    showConfig: false,
    initShell: null,
    dryRun: false,
    quiet: false,
    verbose: false,
    withContext: false,
    noTermContext: false,
    tier: "default", // "default" | "fast" | "smart" | "explicit"
    explicitModel: null,
    fileArgs: [],
    promptWords: [],
    error: null,
  };

  function applyShortFlag(ch) {
    if (ch === "h") out.help = true;
    else if (ch === "V") out.version = true;
    else if (ch === "n") out.dryRun = true;
    else if (ch === "f") out.tier = "fast";
    else if (ch === "s" || ch === "t") out.tier = "smart";
    else if (ch === "c") out.withContext = true;
    else if (ch === "0") out.noTermContext = true;
    else if (ch === "q") out.quiet = true;
    else if (ch === "v") out.verbose = true;
  }

  let passthrough = false;

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (passthrough) {
      out.promptWords.push(arg);
      continue;
    }
    if (arg === "--") {
      passthrough = true;
      continue;
    }

    if (arg === "--help") {
      out.help = true;
      continue;
    }
    if (arg === "--version") {
      out.version = true;
      continue;
    }
    if (arg === "--config") {
      out.showConfig = true;
      continue;
    }
    if (arg === "--init" || arg.startsWith("--init=")) {
      let shellArg = "";
      if (arg.startsWith("--init=")) {
        shellArg = arg.slice("--init=".length).trim().toLowerCase();
      } else if (i + 1 < rawArgs.length && !rawArgs[i + 1].startsWith("-")) {
        const candidate = rawArgs[i + 1].trim().toLowerCase();
        if (SUPPORTED_SHELLS.has(candidate)) {
          shellArg = candidate;
          i++;
        } else if (rawArgs.length === 2) {
          out.error = `Unsupported shell "${rawArgs[i + 1]}". Supported shells: zsh, bash, fish.`;
          return out;
        }
      }
      if (!shellArg) {
        shellArg = detectDefaultShell(env);
      }
      if (!SUPPORTED_SHELLS.has(shellArg)) {
        out.error = `Unsupported shell "${shellArg}". Supported shells: zsh, bash, fish.`;
        return out;
      }
      out.initShell = shellArg;
      continue;
    }

    if (arg === "--dry-run") {
      out.dryRun = true;
      continue;
    }
    if (arg === "--fast") {
      out.tier = "fast";
      continue;
    }
    if (arg === "--smart" || arg === "--think") {
      out.tier = "smart";
      continue;
    }
    if (arg === "--context") {
      out.withContext = true;
      continue;
    }
    if (arg === "--no-term") {
      out.noTermContext = true;
      continue;
    }
    if (arg === "--quiet") {
      out.quiet = true;
      continue;
    }
    if (arg === "--verbose") {
      out.verbose = true;
      continue;
    }

    if (/^-[hVnfstc0qv]+$/.test(arg)) {
      for (const ch of arg.slice(1)) {
        applyShortFlag(ch);
      }
      continue;
    }

    if (arg === "--model" || /^-[hVnfstc0qv]*m$/.test(arg)) {
      if (arg !== "--model") {
        for (const ch of arg.slice(1, -1)) {
          applyShortFlag(ch);
        }
      }
      if (i + 1 >= rawArgs.length) {
        out.error = "-m/--model requires an argument";
        return out;
      }
      out.explicitModel = rawArgs[++i];
      out.tier = "explicit";
      continue;
    }

    if (arg.startsWith("--model=")) {
      const val = arg.slice("--model=".length);
      if (!val) {
        out.error = "--model= requires a non-empty model id";
        return out;
      }
      out.explicitModel = val;
      out.tier = "explicit";
      continue;
    }

    if (arg.startsWith("@") && arg.length > 1) {
      out.fileArgs.push(arg);
      continue;
    }

    out.promptWords.push(arg);
  }

  return out;
}

module.exports = {
  SUPPORTED_SHELLS,
  detectDefaultShell,
  parseArgs,
};
