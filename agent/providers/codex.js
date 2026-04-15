import { spawn } from "child_process";

function buildCodexNewSessionPrompt({ conversation, message, systemPrompt }) {
  const transcript = (conversation.messages || [])
    .map((item) => {
      const speaker = item.role === "assistant" ? "assistant" : "user";
      return `[${speaker}] ${item.text}`;
    })
    .join("\n\n");

  return [
    systemPrompt,
    "你现在作为一个手机聊天里的本地 Codex 助手回复用户。",
    "请基于下面的对话历史，用中文直接回复用户。",
    "只输出最终要发送给用户的正文，不要加解释，不要加前缀。",
    "",
    "当前用户最新消息：",
    message.text,
    "",
    "对话历史：",
    transcript,
  ]
    .filter(Boolean)
    .join("\n");
}

function buildCodexResumePrompt(message) {
  return [
    "继续处理这个手机聊天线程里的新消息。",
    "请用中文直接回复用户，不要加前缀，不要解释你正在使用 Codex。",
    "",
    message.text,
  ].join("\n");
}

async function runCodex({ codexBin, args, cwd, env = process.env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(codexBin, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      reject(new Error(`无法启动 Codex CLI: ${error.message}`));
    });

    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(`Codex CLI 执行失败 (退出码: ${code})${stderr ? `\n${stderr}` : ""}`)
        );
        return;
      }

      const lines = stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);

      let lastAgentMessage = "";
      let threadId = "";

      for (const line of lines) {
        try {
          const event = JSON.parse(line);

          if (event?.type === "thread.started" && event.thread_id) {
            threadId = event.thread_id;
          }

          if (event?.type === "item.completed" && event.item?.type === "agent_message") {
            lastAgentMessage = event.item.text || lastAgentMessage;
          }
        } catch {
          // Codex stdout may include banner or warning lines. Ignore non-JSON output.
        }
      }

      if (!lastAgentMessage) {
        reject(
          new Error(`Codex CLI 没有返回可解析的 agent_message。${stderr ? `\n${stderr}` : ""}`)
        );
        return;
      }

      resolve({
        text: lastAgentMessage.trim(),
        threadId: threadId || null,
      });
    });
  });
}

export function createCodexRuntime({
  codexBin,
  codexModel = "",
  codexSandbox = "read-only",
  defaultWorkdir,
  systemPrompt = "",
  getConversationWorkdir,
  loadRecentSessions,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  env = process.env,
} = {}) {
  return {
    id: "codex",
    capabilities: ["resume_session"],
    async getRegistrationContext() {
      return {
        recentCodexSessions: await loadRecentSessions(),
        defaultCodexWorkdir: defaultWorkdir,
      };
    },
    async reply({ conversation, message }) {
      const codexSessionId = String(conversation?.codexSessionId || "").trim();
      const codexWorkdir = getConversationWorkdir(conversation);
      let result;

      if (codexSessionId) {
        const args = [
          "exec",
          "resume",
          "--skip-git-repo-check",
          "--json",
          "-c",
          "features.apps=false",
        ];

        if (codexModel) {
          args.push("-m", codexModel);
        }

        args.push(codexSessionId, buildCodexResumePrompt(message));
        result = await runCodex({
          codexBin,
          args,
          cwd: codexWorkdir,
          env,
        });
      } else {
        const args = [
          "exec",
          "--skip-git-repo-check",
          "--json",
          "--color",
          "never",
          "-c",
          "features.apps=false",
          "-s",
          codexSandbox,
        ];

        if (codexModel) {
          args.push("-m", codexModel);
        }

        args.push("-C", codexWorkdir);
        args.push(
          buildCodexNewSessionPrompt({
            conversation,
            message,
            systemPrompt,
          })
        );
        result = await runCodex({
          codexBin,
          args,
          cwd: codexWorkdir,
          env,
        });
      }

      await sleep(200);
      const recentCodexSessions = await loadRecentSessions();
      const sessionId =
        codexSessionId || result.threadId || recentCodexSessions[0]?.id || null;
      const session = recentCodexSessions.find((item) => item.id === sessionId) || null;

      return {
        text: result.text,
        codexWorkdir,
        codexSessionId: sessionId,
        codexThreadName: session?.threadName || conversation?.codexThreadName || null,
        codexSessionUpdatedAt: session?.updatedAt || null,
        recentCodexSessions,
      };
    },
  };
}
