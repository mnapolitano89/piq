"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const THINKING_RE = /:(off|minimal|low|medium|high|xhigh|max)$/i;

const BUILTIN_PROVIDERS = new Set([
  "anthropic",
  "openai",
  "openai-codex",
  "google",
  "google-vertex",
  "google-gemini-cli",
  "google-antigravity",
  "mistral",
  "xai",
  "groq",
  "cerebras",
  "openrouter",
  "bedrock",
  "amazon-bedrock",
  "azure-openai",
  "ollama",
  "github-copilot",
  "deepseek",
  "together",
  "fireworks",
  "perplexity",
  "cohere",
  "vercel-ai-gateway",
  "huggingface",
  "lmstudio",
]);

function readJsonSafe(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return {};
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function isExecutable(filePath) {
  try {
    const st = fs.statSync(filePath);
    if (!st.isFile()) return false;
    if (process.platform === "win32") return true;
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function getConfigPaths(env = process.env, homeDir = os.homedir()) {
  const xdgConfig = env.XDG_CONFIG_HOME || path.join(homeDir, ".config");
  const piqConfigPath = env.PIQ_CONFIG || path.join(xdgConfig, "piq", "config.json");
  const piAgentDir = env.PI_CODING_AGENT_DIR || path.join(homeDir, ".pi", "agent");
  const piSettingsPath = path.join(piAgentDir, "settings.json");
  const piModelsPath = path.join(piAgentDir, "models.json");
  return {
    piqConfigPath,
    piAgentDir,
    piSettingsPath,
    piModelsPath,
  };
}

function splitModelSpec(spec) {
  if (!spec || typeof spec !== "string") {
    return { full: "", baseModel: "", provider: "", modelId: "", thinking: "" };
  }
  const trimmed = spec.trim();
  const m = THINKING_RE.exec(trimmed);
  const thinking = m ? m[1].toLowerCase() : "";
  const baseModel = m ? trimmed.slice(0, m.index) : trimmed;
  const slashIdx = baseModel.indexOf("/");
  const provider = slashIdx > 0 ? baseModel.slice(0, slashIdx) : "";
  const modelId = slashIdx > 0 ? baseModel.slice(slashIdx + 1) : baseModel;
  return { full: trimmed, baseModel, provider, modelId, thinking };
}

function withDefaultThinking(spec, defaultLevel) {
  if (!spec) return "";
  const { baseModel, thinking } = splitModelSpec(spec);
  return `${baseModel}:${thinking || defaultLevel}`;
}

function replaceThinking(spec, level) {
  if (!spec) return "";
  const { baseModel } = splitModelSpec(spec);
  return `${baseModel}:${level}`;
}

function findAutoFastModel({ defaultBaseModel, piSettings, piModels }) {
  const { provider, modelId } = splitModelSpec(defaultBaseModel);
  if (!provider) return "";

  const candidates = [];
  const seen = new Set();
  const addCandidate = (id) => {
    if (!id || typeof id !== "string") return;
    const clean = splitModelSpec(id).baseModel;
    const bare = clean.startsWith(`${provider}/`) ? clean.slice(provider.length + 1) : clean;
    if (!bare || seen.has(bare)) return;
    seen.add(bare);
    candidates.push(bare);
  };

  const provModels = piModels?.providers?.[provider]?.models;
  if (Array.isArray(provModels)) {
    for (const entry of provModels) {
      if (entry && typeof entry.id === "string") addCandidate(entry.id);
    }
  }

  if (Array.isArray(piSettings?.enabledModels)) {
    for (const pat of piSettings.enabledModels) {
      if (typeof pat === "string" && pat.startsWith(`${provider}/`) && !pat.includes("*")) {
        addCandidate(pat);
      }
    }
  }

  const FAST_TOKEN_RE = /(?:^|[-_./])(flash|haiku|mini|nano|lite)(?:$|[-_.\d])/i;
  const fastHits = candidates.filter((id) => FAST_TOKEN_RE.test(id));
  if (fastHits.length === 0) return "";

  // Prefer a fast sibling from the same major model family (e.g. gemini-4-* when default is gemini-4-*)
  const familyPrefix = modelId.split("-").slice(0, 2).join("-").toLowerCase();
  const sameFamily = familyPrefix
    ? fastHits.filter((id) => id.toLowerCase().startsWith(familyPrefix))
    : [];
  const chosen = (sameFamily.length > 0 ? sameFamily : fastHits)[
    (sameFamily.length > 0 ? sameFamily : fastHits).length - 1
  ];
  return `${provider}/${chosen}:low`;
}

/**
 * Two tiers: fast (the default) and smart (-s). `model` / PIQ_MODEL are deprecated
 * aliases for the fast model, used only when no fast model is configured.
 */
function resolveModels({ tier = "fast", explicitModel = null, env = process.env, piqConfig = {}, piSettings = {}, piModels = {} }) {
  let inheritedBase = "";
  if (typeof piSettings.defaultModel === "string" && piSettings.defaultModel.trim()) {
    const dm = piSettings.defaultModel.trim();
    if (dm.includes("/")) {
      inheritedBase = splitModelSpec(dm).baseModel;
    } else if (typeof piSettings.defaultProvider === "string" && piSettings.defaultProvider.trim()) {
      inheritedBase = `${piSettings.defaultProvider.trim()}/${splitModelSpec(dm).baseModel}`;
    } else {
      inheritedBase = splitModelSpec(dm).baseModel;
    }
  }

  const legacyModel = env.PIQ_MODEL || piqConfig.model || "";
  // Family anchor for auto-detecting a fast sibling and for the smart model.
  const anchorBase = inheritedBase || splitModelSpec(legacyModel).baseModel;

  const fastModel =
    env.PIQ_FAST_MODEL ||
    env.PIQ_MODEL ||
    piqConfig.fastModel ||
    piqConfig.model ||
    findAutoFastModel({ defaultBaseModel: anchorBase, piSettings, piModels }) ||
    (anchorBase ? `${anchorBase}:low` : "");

  const smartModel =
    env.PIQ_SMART_MODEL ||
    piqConfig.smartModel ||
    (anchorBase ? `${anchorBase}:high` : "");

  let selectedModel = fastModel;
  let fallbackThinking = "low";

  if (tier === "explicit" && explicitModel) {
    selectedModel = explicitModel;
  } else if (tier === "smart") {
    selectedModel = smartModel;
    fallbackThinking = "high";
  }

  const parsed = splitModelSpec(selectedModel);
  return {
    // Set when deprecated `model`/PIQ_MODEL is present: "used" or "ignored" (fast model set).
    legacyModelStatus: legacyModel ? (fastModel === legacyModel ? "used" : "ignored") : "",
    fastModel,
    smartModel,
    selectedModel: parsed.full,
    baseModel: parsed.baseModel,
    provider: parsed.provider,
    thinking: parsed.thinking,
    fallbackThinking,
  };
}

function resolveRequiredExtensions({ baseModel, env = process.env, piqConfig = {}, piSettings = {}, piModels = {} }) {
  const exts = [];
  const addExt = (s) => {
    if (typeof s === "string" && s.trim() && !exts.includes(s.trim())) {
      exts.push(s.trim());
    }
  };

  if (typeof env.PIQ_EXTENSIONS === "string" && env.PIQ_EXTENSIONS.trim()) {
    for (const item of env.PIQ_EXTENSIONS.split(",")) addExt(item);
  }
  if (Array.isArray(piqConfig.extensions)) {
    for (const item of piqConfig.extensions) addExt(item);
  }

  const { provider } = splitModelSpec(baseModel);
  if (!provider) return exts;

  // Built-in providers and custom providers defined directly in models.json need no extension
  if (BUILTIN_PROVIDERS.has(provider.toLowerCase())) return exts;
  if (piModels?.providers && Object.prototype.hasOwnProperty.call(piModels.providers, provider)) {
    return exts;
  }

  // Otherwise scan ~/.pi/agent/settings.json packages for a matching provider extension
  const packages = Array.isArray(piSettings?.packages) ? piSettings.packages : [];
  const needle = provider.toLowerCase();
  for (const entry of packages) {
    const src = typeof entry === "string" ? entry : entry && typeof entry.source === "string" ? entry.source : "";
    if (src && src.toLowerCase().includes(needle)) {
      addExt(src);
    }
  }

  return exts;
}

function resolvePiBin({ env = process.env, homeDir = os.homedir(), piqConfig = {}, piAgentDir } = {}) {
  if (env.PIQ_PI_BIN && env.PIQ_PI_BIN.trim()) {
    return env.PIQ_PI_BIN.trim();
  }
  if (typeof piqConfig.piBin === "string" && piqConfig.piBin.trim()) {
    return piqConfig.piBin.trim();
  }
  const agentDir = piAgentDir || env.PI_CODING_AGENT_DIR || path.join(homeDir, ".pi", "agent");
  const defaultAgentBin = path.join(agentDir, "bin", "pi");
  if (isExecutable(defaultAgentBin)) {
    return defaultAgentBin;
  }
  const pathDirs = String(env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    const candidate = path.join(dir, process.platform === "win32" ? "pi.cmd" : "pi");
    if (isExecutable(candidate)) {
      return candidate;
    }
  }
  return "pi";
}

function loadResolvedConfig({ tier = "fast", explicitModel = null, env = process.env, homeDir = os.homedir() } = {}) {
  const paths = getConfigPaths(env, homeDir);
  const piqConfig = readJsonSafe(paths.piqConfigPath);
  const piSettings = readJsonSafe(paths.piSettingsPath);
  const piModels = readJsonSafe(paths.piModelsPath);

  const models = resolveModels({
    tier,
    explicitModel,
    env,
    piqConfig,
    piSettings,
    piModels,
  });

  const extensions = resolveRequiredExtensions({
    baseModel: models.baseModel,
    env,
    piqConfig,
    piSettings,
    piModels,
  });

  const piBin = resolvePiBin({
    env,
    homeDir,
    piqConfig,
    piAgentDir: paths.piAgentDir,
  });

  return {
    paths,
    piBin,
    models,
    extensions,
    hasPiqConfigFile: fs.existsSync(paths.piqConfigPath),
    hasPiSettingsFile: fs.existsSync(paths.piSettingsPath),
  };
}

module.exports = {
  BUILTIN_PROVIDERS,
  readJsonSafe,
  getConfigPaths,
  splitModelSpec,
  withDefaultThinking,
  replaceThinking,
  findAutoFastModel,
  resolveModels,
  resolveRequiredExtensions,
  resolvePiBin,
  loadResolvedConfig,
};
