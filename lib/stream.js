"use strict";

const os = require("node:os");

/** Shell convention: a process killed by signal N exits with 128 + N (SIGINT -> 130). */
function signalExitCode(signal) {
  const num = signal ? os.constants.signals[signal] : undefined;
  return typeof num === "number" ? 128 + num : 1;
}

function makeColors(isTTY) {
  return {
    dim: (s) => (isTTY ? `\x1b[2m${s}\x1b[0m` : s),
    cyan: (s) => (isTTY ? `\x1b[36m${s}\x1b[0m` : s),
    green: (s) => (isTTY ? `\x1b[32m${s}\x1b[0m` : s),
    yellow: (s) => (isTTY ? `\x1b[33m${s}\x1b[0m` : s),
    red: (s) => (isTTY ? `\x1b[31m${s}\x1b[0m` : s),
    bold: (s) => (isTTY ? `\x1b[1m${s}\x1b[0m` : s),
  };
}

function formatToolSummary(toolName, args) {
  if (!args || typeof args !== "object") return toolName;
  if (toolName === "bash" && args.command) {
    const oneLine = String(args.command).replace(/\s*\n\s*/g, "; ").trim();
    return `$ ${oneLine.length > 140 ? oneLine.slice(0, 137) + "..." : oneLine}`;
  }
  if (args.path) return `${toolName} ${args.path}`;
  if (args.pattern) return `${toolName} ${args.pattern}`;
  return toolName;
}

function classifyError(errMsg, errInfo) {
  const msg = String(errMsg || "");
  const zeroResponse =
    Boolean(errInfo) &&
    errInfo.contentLen === 0 &&
    errInfo.inputTokens === 0 &&
    errInfo.outputTokens === 0 &&
    errInfo.totalTokens === 0;

  if (
    /usage policy|violate.*policy|unable to respond to this request/i.test(msg) ||
    /Provider stopped with:\s*(SAFETY|PROHIBITED_CONTENT|BLOCKLIST|SPII|RECITATION|IMAGE_SAFETY|IMAGE_PROHIBITED_CONTENT)/i.test(
      msg
    ) ||
    /\b(PROHIBITED_CONTENT|SAFETY|BLOCKLIST|SPII)\b/.test(msg)
  ) {
    return {
      tag: "policy-filter",
      isLikelyFilter: true,
      definiteFilter: true,
      hint: "Prompt hit an upstream safety/policy filter. Try adding explicit technical context or switching models with -f or -m <provider/model>.",
    };
  }

  if (/stream ended without a finish reason/i.test(msg) && zeroResponse) {
    return {
      tag: "policy-filter?",
      isLikelyFilter: true,
      definiteFilter: false,
      hint: "Upstream returned an empty 0-token stream without finishReason (often an input safety filter). Try rephrasing with explicit technical context or switching models with -f or -m <provider/model>.",
    };
  }

  if (/429|rate.?limit|quota|resource.?exhausted|too many requests/i.test(msg)) {
    return { tag: "rate-limit", isLikelyFilter: false, definiteFilter: false, hint: "" };
  }
  if (/500|502|503|504|529|overloaded|unavailable|internal|bad gateway|service unavailable/i.test(msg)) {
    return { tag: "provider-5xx", isLikelyFilter: false, definiteFilter: false, hint: "" };
  }
  if (/timeout|timed out|econnreset|econnrefused|etimedout|socket|network|fetch failed|terminated/i.test(msg)) {
    return { tag: "network", isLikelyFilter: false, definiteFilter: false, hint: "" };
  }
  return { tag: "provider-error", isLikelyFilter: false, definiteFilter: false, hint: "" };
}

function createStreamProcessor({
  stdout = process.stdout,
  stderr = process.stderr,
  quiet = false,
  verbose = false,
  isTTYErr = Boolean(stderr.isTTY),
  finalOnly = false, // print only the last assistant message's text, at the end
  onAbortChild = () => {},
} = {}) {
  const c = makeColors(isTTYErr);
  const activeTools = new Map();
  let lastPrintedTextNewline = true;
  let currentMsgText = "";
  let lastMsgText = "";
  let hadAssistantError = false;
  let assistantErrorMsg = "";
  let lastAssistantError = null;
  let abortedEarlyByFilter = false;
  let earlyAbortReason = "";
  let stdoutBuf = "";

  // Terminate a partial stdout line before stderr progress or a new assistant turn.
  function endStdoutLine() {
    if (!lastPrintedTextNewline) {
      stdout.write("\n");
      lastPrintedTextNewline = true;
    }
  }

  function handleEvent(ev) {
    if (!ev || typeof ev !== "object") return;

    if (ev.type === "tool_execution_start") {
      activeTools.set(ev.toolCallId, { toolName: ev.toolName, args: ev.args });
      if (!quiet) {
        endStdoutLine();
        const summary = formatToolSummary(ev.toolName, ev.args);
        stderr.write(`${c.cyan("▸")} ${c.dim(summary)}\n`);
      }
      return;
    }

    if (ev.type === "tool_execution_update" && verbose && !quiet) {
      const text = ev.partialResult?.content
        ?.filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");
      if (text) {
        const lines = text.trimEnd().split("\n").slice(-3);
        for (const l of lines) {
          stderr.write(`  ${c.dim("│ " + l)}\n`);
        }
      }
      return;
    }

    if (ev.type === "tool_execution_end") {
      activeTools.delete(ev.toolCallId);
      if (!quiet) {
        const dur = typeof ev.durationMs === "number" ? `${(ev.durationMs / 1000).toFixed(1)}s` : "";
        if (ev.isError) {
          const errText = ev.result?.content
            ?.filter((b) => b.type === "text")
            .map((b) => b.text)
            .join("\n")
            .trim();
          stderr.write(`${c.red("✗")} ${c.red(`failed${dur ? ` (${dur})` : ""}`)}\n`);
          if (errText) {
            const snippet = errText.split("\n").slice(-5).join("\n");
            stderr.write(`${c.dim(snippet)}\n`);
          }
        } else if (dur && ev.durationMs >= 1000) {
          stderr.write(`${c.green("✓")} ${c.dim(dur)}\n`);
        }
      }
      return;
    }

    if (ev.type === "message_start" && ev.message?.role === "assistant") {
      hadAssistantError = false;
      assistantErrorMsg = "";
      currentMsgText = "";
      // Keep separate turns on separate lines (otherwise -q glued them together).
      endStdoutLine();
      return;
    }

    if (ev.type === "message_update" && ev.assistantMessageEvent) {
      const ame = ev.assistantMessageEvent;
      if (ame.type === "text_delta" && ame.delta) {
        currentMsgText += ame.delta;
        if (!finalOnly) {
          stdout.write(ame.delta);
          lastPrintedTextNewline = ame.delta.endsWith("\n");
        }
      }
      return;
    }

    if (ev.type === "message_end" && ev.message?.role === "assistant") {
      if (currentMsgText.trim()) {
        lastMsgText = currentMsgText;
      }
      if (ev.message.stopReason === "error" || ev.message.stopReason === "aborted") {
        hadAssistantError = true;
        assistantErrorMsg = ev.message.errorMessage || `Stopped (${ev.message.stopReason})`;
        const u = ev.message.usage || {};
        lastAssistantError = {
          errorMessage: assistantErrorMsg,
          rawStopReason: ev.message.rawStopReason || "",
          contentLen: Array.isArray(ev.message.content) ? ev.message.content.length : 0,
          inputTokens: Number(u.input || 0),
          outputTokens: Number(u.output || 0),
          totalTokens: Number(u.totalTokens || 0),
        };
      } else {
        hadAssistantError = false;
        assistantErrorMsg = "";
        lastAssistantError = null;
      }
      return;
    }

    if (ev.type === "auto_retry_start") {
      const msg = ev.errorMessage || assistantErrorMsg || "Unknown error";
      const cls = classifyError(msg, lastAssistantError);
      const delayS = typeof ev.delayMs === "number" ? `${Math.round(ev.delayMs / 1000)}s` : "";
      if (!quiet) {
        endStdoutLine();
        const tagText = cls.isLikelyFilter ? c.red(`[${cls.tag}]`) : c.yellow(`[${cls.tag}]`);
        stderr.write(
          `${c.yellow("↻")} ${tagText} ${c.dim(`retry ${ev.attempt}/${ev.maxAttempts}${delayS ? ` in ${delayS}` : ""}: ${msg}`)}\n`
        );
      }
      if ((cls.definiteFilter || (cls.isLikelyFilter && ev.attempt >= 2)) && !abortedEarlyByFilter) {
        abortedEarlyByFilter = true;
        earlyAbortReason = msg;
        if (!quiet) {
          stderr.write(`${c.red("✗")} ${c.dim("aborting retries after repeated empty/policy block")}\n`);
        }
        onAbortChild();
      }
      return;
    }

    if (ev.type === "auto_retry_end") {
      if (ev.success) {
        hadAssistantError = false;
        assistantErrorMsg = "";
        lastAssistantError = null;
        if (!quiet) {
          endStdoutLine();
          stderr.write(`${c.green("✓")} ${c.dim(`recovered on attempt ${ev.attempt}`)}\n`);
        }
      } else {
        hadAssistantError = true;
        if (ev.finalError) assistantErrorMsg = ev.finalError;
      }
    }
  }

  function feedStdoutChunk(chunk) {
    stdoutBuf += chunk;
    let nlIdx;
    while ((nlIdx = stdoutBuf.indexOf("\n")) !== -1) {
      let line = stdoutBuf.slice(0, nlIdx);
      stdoutBuf = stdoutBuf.slice(nlIdx + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line) continue;
      try {
        handleEvent(JSON.parse(line));
      } catch {
        // ignore malformed line
      }
    }
  }

  function feedStderrChunk(chunk) {
    const filtered = String(chunk)
      .split("\n")
      .filter((line) => !line.startsWith('Warning: No models match pattern "'))
      .join("\n");
    if (filtered.trim()) {
      stderr.write(c.dim(filtered));
    }
  }

  function finalize(exitCode, signal = null) {
    if (stdoutBuf.trim()) {
      try {
        handleEvent(JSON.parse(stdoutBuf.trim()));
      } catch {
        // ignore trailing partial
      }
      stdoutBuf = "";
    }
    if (!lastPrintedTextNewline) {
      stdout.write("\n");
      lastPrintedTextNewline = true;
    }
    const finalMsg = abortedEarlyByFilter ? earlyAbortReason : assistantErrorMsg;
    if ((hadAssistantError || abortedEarlyByFilter) && finalMsg) {
      const cls = classifyError(finalMsg, lastAssistantError);
      stderr.write(`${c.red(`piq error [${cls.tag}]:`)} ${finalMsg}\n`);
      if (cls.hint) {
        stderr.write(`${c.dim(cls.hint)}\n`);
      }
      // piq itself SIGTERMs the child on an early filter abort; report that as a plain error.
      if (abortedEarlyByFilter) return 1;
      return exitCode || (signal ? signalExitCode(signal) : 1);
    }
    if (exitCode === null || exitCode === undefined) {
      if (signal) return signalExitCode(signal);
      exitCode = 0;
    }
    if (finalOnly && lastMsgText) {
      stdout.write(lastMsgText.endsWith("\n") ? lastMsgText : `${lastMsgText}\n`);
    }
    return exitCode;
  }

  return {
    handleEvent,
    feedStdoutChunk,
    feedStderrChunk,
    finalize,
  };
}

module.exports = {
  signalExitCode,
  makeColors,
  formatToolSummary,
  classifyError,
  createStreamProcessor,
};
