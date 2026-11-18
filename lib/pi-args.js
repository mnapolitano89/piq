"use strict";

const READ_ONLY_TOOLS = "read,ls,find,grep";
const EXECUTE_TOOLS = "bash,read,write,edit,ls,find,grep";

/**
 * Build the argv for `pi`. Terminal context travels as an @file attachment
 * (contextFilePath) so it lands in the user message as data, not in the system prompt.
 */
function buildPiArgs({ parsed, resolved, sysPrompt, promptText, contextFilePath = "" }) {
  const piArgs = [
    "--mode",
    "json",
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-mcp",
  ];

  if (resolved.models.selectedModel && resolved.models.baseModel) {
    piArgs.push("--models", resolved.models.baseModel, "--model", resolved.models.selectedModel);
  } else {
    piArgs.push("--thinking", resolved.models.fallbackThinking);
  }

  piArgs.push("--tools", parsed.execute ? EXECUTE_TOOLS : READ_ONLY_TOOLS, "--append-system-prompt", sysPrompt);

  if (!parsed.withContext) {
    piArgs.push("--no-context-files");
  }
  for (const ext of resolved.extensions) {
    piArgs.push("-e", ext);
  }
  if (contextFilePath) {
    piArgs.push(`@${contextFilePath}`);
  }
  for (const f of parsed.fileArgs) {
    piArgs.push(f);
  }
  if (promptText) {
    piArgs.push("--", promptText);
  }
  return piArgs;
}

module.exports = {
  READ_ONLY_TOOLS,
  EXECUTE_TOOLS,
  buildPiArgs,
};
