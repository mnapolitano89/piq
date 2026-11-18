"use strict";

const fs = require("node:fs");

/**
 * Decide how to treat a non-TTY stdin without risking a hang.
 *
 * - "pipe":  FIFO or regular file (`cmd | piq`, `piq < file`). Always forward, even if the
 *            producer is slow to write.
 * - "probe": socket. Programmatic callers (Node's spawn, many agent harnesses, editors) hand
 *            children a socketpair that may never be written to or closed, which would leave
 *            pi blocked reading stdin. Forward only if data or EOF arrives quickly.
 * - "none":  TTY, /dev/null and other character devices, or anything unknown.
 */
function classifyStdin(fd = 0, isTTY = Boolean(process.stdin.isTTY)) {
  if (isTTY) return "none";
  let st;
  try {
    st = fs.fstatSync(fd);
  } catch {
    return "none";
  }
  if (st.isFIFO() || st.isFile()) return "pipe";
  if (st.isSocket()) return "probe";
  return "none";
}

/**
 * Wait up to timeoutMs for the first chunk or EOF on a readable stream.
 * Resolves "data" (chunk pushed back with unshift so piping sees it), "eof", or "timeout".
 */
function probeStdin(stream, timeoutMs = 300) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stream.removeListener("readable", onReadable);
      stream.removeListener("end", onEnd);
      stream.removeListener("error", onEnd);
      resolve(result);
    };
    const onReadable = () => {
      const chunk = stream.read();
      if (chunk !== null) {
        stream.unshift(chunk);
        finish("data");
      }
    };
    const onEnd = () => finish("eof");
    const timer = setTimeout(() => finish("timeout"), timeoutMs);
    stream.on("readable", onReadable);
    stream.once("end", onEnd);
    stream.once("error", onEnd);
  });
}

/**
 * Resolve whether piq should forward stdin to pi: returns true to pipe, false to give pi
 * /dev/null. Destroys an idle probed stream so it cannot keep the process alive.
 */
async function resolveStdinForwarding({ stream = process.stdin, mode = classifyStdin(), timeoutMs = 300 } = {}) {
  if (mode === "pipe") return true;
  if (mode !== "probe") return false;
  const result = await probeStdin(stream, timeoutMs);
  if (result === "data") return true;
  stream.pause();
  stream.destroy();
  return false;
}

module.exports = {
  classifyStdin,
  probeStdin,
  resolveStdinForwarding,
};
