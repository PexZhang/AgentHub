import { spawn } from "child_process";
import { EventEmitter } from "events";

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
    message.composedText || message.text,
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
    message.composedText || message.text,
  ].join("\n");
}

// Streaming Codex runner that emits events as they arrive from stdout
function runCodexStreaming({ codexBin, args, cwd, env = process.env }) {
  const emitter = new EventEmitter();
  let buffer = "";
  let stderr = "";
  let child = null;
  let settled = false;

  const childProcess = spawn(codexBin, args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env,
  });
  child = childProcess;

  childProcess.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const event = JSON.parse(trimmed);
        emitter.emit("event", event);

        if (event?.type === "thread.started" && event.thread_id) {
          emitter.emit("thread_started", event.thread_id);
        }

        if (event?.type === "item.completed" && event.item?.type === "agent_message") {
          emitter.emit("agent_message", event.item.text || "");
        }

        // Detect approval/confirmation requests from Codex CLI
        if (event?.type === "item.pending_approval" || event?.type === "approval_requested") {
          emitter.emit("approval_needed", {
            id: event.id || event.item?.id || null,
            reason: event.reason || event.item?.reason || "Codex 需要确认才能继续",
            scope: event.scope || event.item?.scope || null,
            requestedAction: event.action || event.item?.action || null,
            riskLevel: event.risk_level || event.item?.risk_level || "medium",
          });
        }

        // Codex tool calls that need user confirmation
        if (
          event?.type === "item.status" &&
          event.item?.status === "pending_approval"
        ) {
          emitter.emit("approval_needed", {
            id: event.item?.id || null,
            reason: event.item?.call?.name
              ? `执行操作: ${event.item.call.name}`
              : "Codex 需要确认才能继续",
            scope: event.item?.call?.name || null,
            requestedAction: event.item?.call?.name || null,
            riskLevel: "medium",
          });
        }

        // Progress: function calls completed
        if (event?.type === "item.completed" && event.item?.type === "function_call") {
          emitter.emit("progress", {
            type: "function_call",
            name: event.item.name || event.item.call?.name || "unknown",
            summary: `执行了: ${event.item.name || event.item.call?.name || "操作"}`,
          });
        }

        // Progress: reasoning step
        if (event?.type === "item.completed" && event.item?.type === "reasoning") {
          emitter.emit("progress", {
            type: "reasoning",
            summary: "思考中...",
          });
        }
      } catch {
        // Non-JSON output from Codex CLI, ignore
      }
    }
  });

  childProcess.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  childProcess.on("error", (error) => {
    if (!settled) {
      settled = true;
      emitter.emit("error", new Error(`无法启动 Codex CLI: ${error.message}`));
    }
  });

  childProcess.on("close", (code) => {
    // Process any remaining buffer
    if (buffer.trim()) {
      try {
        const event = JSON.parse(buffer.trim());
        emitter.emit("event", event);
        if (event?.type === "item.completed" && event.item?.type === "agent_message") {
          emitter.emit("agent_message", event.item.text || "");
        }
      } catch {
        // ignore
      }
    }

    if (!settled) {
      settled = true;
      if (code !== 0) {
        emitter.emit(
          "error",
          new Error(`Codex CLI 执行失败 (退出码: ${code})${stderr ? `\n${stderr}` : ""}`)
        );
      } else {
        emitter.emit("close", code);
      }
    }
  });

  // Send approval decision back to Codex via stdin
  emitter.approve = (approved = true) => {
    if (child && child.stdin && !child.stdin.destroyed) {
      const response = approved ? "yes\n" : "no\n";
      child.stdin.write(response);
    }
  };

  // Send arbitrary input to Codex stdin (for future interactive use)
  emitter.sendInput = (text) => {
    if (child && child.stdin && !child.stdin.destroyed) {
      child.stdin.write(text);
    }
  };

  emitter.kill = (signal = "SIGTERM") => {
    if (child && !child.killed) {
      child.kill(signal);
    }
  };

  emitter.child = child;

  return emitter;
}

export function createCodexRuntime({
  codexBin,
  codexModel = "",
  codexSandbox = "danger-full-access",
  defaultWorkdir,
  systemPrompt = "",
  getConversationWorkdir,
  loadRecentSessions,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  env = process.env,
} = {}) {
  // Track the currently running Codex process for long-task intervention
  let activeRun = null;

  return {
    id: "codex",
    capabilities: ["resume_session", "long_task", "streaming_progress", "approval_flow"],

    // Expose the active runner so agent/index.js can forward approval decisions
    getActiveRun() {
      return activeRun;
    },

    // Called when Hub sends approval decision back to this agent
    resolveApproval(decision) {
      if (activeRun) {
        activeRun.approve(decision === "approved");
      }
    },

    async getRegistrationContext() {
      return {
        recentCodexSessions: await loadRecentSessions(),
        defaultCodexWorkdir: defaultWorkdir,
      };
    },

    // Streaming reply with progress callbacks and approval flow support
    async reply({ conversation, message, onProgress, onApprovalNeeded }) {
      const codexSessionId = String(conversation?.codexSessionId || "").trim();
      const codexWorkdir = getConversationWorkdir(conversation);

      let args;
      if (codexSessionId) {
        args = [
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
      } else {
        args = [
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
      }

      const runner = runCodexStreaming({
        codexBin,
        args,
        cwd: codexWorkdir,
        env,
      });

      activeRun = runner;

      return new Promise((resolve, reject) => {
        let lastAgentMessage = "";
        let threadId = "";

        runner.on("thread_started", (id) => {
          threadId = id;
        });

        runner.on("agent_message", (text) => {
          lastAgentMessage = text;
          if (onProgress) {
            onProgress({
              type: "agent_message",
              summary: text.length > 200 ? text.slice(0, 200) + "..." : text,
              fullText: text,
            });
          }
        });

        runner.on("progress", (info) => {
          if (onProgress) {
            onProgress(info);
          }
        });

        runner.on("approval_needed", (info) => {
          if (onApprovalNeeded) {
            onApprovalNeeded(info);
          }
        });

        runner.on("error", (error) => {
          activeRun = null;
          reject(error);
        });

        runner.on("close", async () => {
          activeRun = null;

          if (!lastAgentMessage) {
            reject(new Error("Codex CLI 没有返回可解析的 agent_message。"));
            return;
          }

          await sleep(200);
          const recentCodexSessions = await loadRecentSessions();
          const sessionId =
            codexSessionId || threadId || recentCodexSessions[0]?.id || null;
          const session =
            recentCodexSessions.find((item) => item.id === sessionId) || null;

          resolve({
            text: lastAgentMessage.trim(),
            codexWorkdir,
            codexSessionId: sessionId,
            codexThreadName: session?.threadName || conversation?.codexThreadName || null,
            codexSessionUpdatedAt: session?.updatedAt || null,
            recentCodexSessions,
          });
        });
      });
    },
  };
}
