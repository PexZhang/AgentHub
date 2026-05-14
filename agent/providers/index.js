import { createCodexRuntime } from "./codex.js";
import { createClaudeRuntime } from "./claude.js";
import { createEchoRuntime } from "./echo.js";
import { createOpenAIRuntime } from "./openai.js";

export function createRuntimeAdapter({
  mode,
  agentName,
  systemPrompt,
  openaiApiKey,
  openaiModel,
  claudeModel,
  codexBin,
  codexModel,
  codexSandbox,
  defaultWorkdir,
  getConversationWorkdir,
  getConversationCodexHome,
  loadRecentCodexSessions,
  sleep,
  env,
} = {}) {
  if (mode === "claude") {
    return createClaudeRuntime({
      model: claudeModel || "claude-opus-4-6",
      systemPrompt,
    });
  }

  if (mode === "openai" && openaiApiKey) {
    return createOpenAIRuntime({
      apiKey: openaiApiKey,
      model: openaiModel,
      systemPrompt,
    });
  }

  if (mode === "codex") {
    return createCodexRuntime({
      codexBin,
      codexModel,
      codexSandbox,
      defaultWorkdir,
      systemPrompt,
      getConversationWorkdir,
      getConversationCodexHome,
      loadRecentSessions: loadRecentCodexSessions,
      sleep,
      env,
    });
  }

  return createEchoRuntime({
    agentName,
    sleep,
    fallbackHint:
      "如果你配置了 OPENAI_API_KEY，并把 AGENT_MODE 改成 openai，它就会改为真实模型回复。",
  });
}
