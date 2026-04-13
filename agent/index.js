import "dotenv/config";
import WebSocket from "ws";
import { spawn } from "child_process";
import { promises as fs } from "fs";
import { join, resolve, sep } from "path";
import os from "os";

function normalizeText(value) {
  return String(value || "").trim();
}

const HUB_ORIGIN = process.env.HUB_ORIGIN || "http://localhost:3000";
const HUB_WS_URL = HUB_ORIGIN.replace(/^http/, "ws") + "/ws";
const AGENT_ID = process.env.AGENT_ID || "local-ai";
const AGENT_NAME = process.env.AGENT_NAME || "Digital Employee";
const AGENT_MODE = process.env.AGENT_MODE || "echo";
const AGENT_TOKEN = process.env.AGENT_TOKEN || "";
const DEVICE_ID = normalizeText(process.env.DEVICE_ID) || os.hostname();
const DEVICE_NAME = normalizeText(process.env.DEVICE_NAME) || DEVICE_ID;
const AGENT_PROMPT =
  process.env.AGENT_PROMPT ||
  "你是 AgentHub 里的一个数字员工，要用简洁、可靠、可执行的方式帮助用户推进任务。";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5";
const CODEX_BIN = process.env.CODEX_BIN || "codex";
const CODEX_WORKDIR = process.env.CODEX_WORKDIR || process.cwd();
const CODEX_MODEL = process.env.CODEX_MODEL || "";
const CODEX_SANDBOX = process.env.CODEX_SANDBOX || "read-only";
const CODEX_HOME = process.env.CODEX_HOME || join(os.homedir(), ".codex");
const CODEX_SESSION_INDEX = join(CODEX_HOME, "session_index.jsonl");
const MAX_RECENT_CODEX_SESSIONS = 12;
const AGENT_WORKDIR_ROOTS = (process.env.AGENT_WORKDIR_ROOTS || CODEX_WORKDIR)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean)
  .map((value) => resolve(value))
  .filter((value, index, all) => all.indexOf(value) === index);
const DEFAULT_CODEX_WORKDIR = resolve(CODEX_WORKDIR);

const processedMessages = new Set();
let authFailed = false;
const availableRuntimes = [
  "echo",
  ...(OPENAI_API_KEY ? ["openai"] : []),
  ...(CODEX_BIN ? ["codex"] : []),
].filter((value, index, all) => all.indexOf(value) === index);
const currentMode = availableRuntimes.includes(AGENT_MODE) ? AGENT_MODE : "echo";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeWorkdir(value) {
  return resolve(String(value || DEFAULT_CODEX_WORKDIR));
}

function isWithinAllowedRoot(targetPath) {
  return AGENT_WORKDIR_ROOTS.some(
    (root) => targetPath === root || targetPath.startsWith(`${root}${sep}`)
  );
}

function getConversationWorkdir(conversation) {
  const candidate = normalizeWorkdir(conversation?.codexWorkdir || DEFAULT_CODEX_WORKDIR);
  return isWithinAllowedRoot(candidate) ? candidate : DEFAULT_CODEX_WORKDIR;
}

async function listDirectories(pathValue) {
  const requestedPath = normalizeWorkdir(pathValue || DEFAULT_CODEX_WORKDIR);
  if (pathValue && !isWithinAllowedRoot(requestedPath)) {
    throw new Error("所选目录不在允许范围内");
  }

  const targetPath = isWithinAllowedRoot(requestedPath)
    ? requestedPath
    : DEFAULT_CODEX_WORKDIR;

  const stats = await fs.stat(targetPath);
  if (!stats.isDirectory()) {
    throw new Error("目标路径不是目录");
  }

  const entries = await fs.readdir(targetPath, { withFileTypes: true });
  const directories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      path: join(targetPath, entry.name),
    }))
    .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));

  const containingRoot = AGENT_WORKDIR_ROOTS.find(
    (root) => targetPath === root || targetPath.startsWith(`${root}${sep}`)
  );
  const parentPath =
    containingRoot && targetPath !== containingRoot ? resolve(targetPath, "..") : null;

  const safeParentPath =
    parentPath && isWithinAllowedRoot(parentPath) ? parentPath : null;

  return {
    path: targetPath,
    parentPath: safeParentPath,
    roots: AGENT_WORKDIR_ROOTS,
    entries: directories,
  };
}

async function loadRecentCodexSessions() {
  if (!CODEX_BIN) {
    return [];
  }

  try {
    const raw = await fs.readFile(CODEX_SESSION_INDEX, "utf8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          const item = JSON.parse(line);
          if (!item?.id) {
            return null;
          }

          return {
            id: String(item.id),
            threadName: String(item.thread_name || item.threadName || "未命名 Session"),
            updatedAt: item.updated_at || item.updatedAt || null,
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((left, right) => {
        const leftTime = new Date(left.updatedAt || 0).getTime();
        const rightTime = new Date(right.updatedAt || 0).getTime();
        return rightTime - leftTime;
      })
      .slice(0, MAX_RECENT_CODEX_SESSIONS);
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn("Failed to read Codex session index:", error.message);
    }
    return [];
  }
}

function sendJson(ws, payload) {
  if (ws.readyState !== 1) {
    return;
  }
  ws.send(JSON.stringify(payload));
}

function toOpenAIInput(conversation) {
  const items = [];

  if (AGENT_PROMPT) {
    items.push({ role: "system", content: AGENT_PROMPT });
  }

  for (const message of conversation.messages || []) {
    if (message.role === "assistant") {
      items.push({ role: "assistant", content: message.text });
      continue;
    }

    if (message.role === "user") {
      items.push({ role: "user", content: message.text });
    }
  }

  return items;
}

async function askOpenAI(conversation) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      input: toOpenAIInput(conversation),
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI 请求失败: ${response.status} ${errorText}`);
  }

  const json = await response.json();
  return json.output_text || "我收到了消息，但没有生成文本回复。";
}

function buildCodexNewSessionPrompt(conversation, message) {
  const transcript = (conversation.messages || [])
    .map((item) => {
      const speaker = item.role === "assistant" ? "assistant" : "user";
      return `[${speaker}] ${item.text}`;
    })
    .join("\n\n");

  return [
    AGENT_PROMPT,
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

async function runCodex(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(CODEX_BIN, args, {
      cwd: options.cwd || DEFAULT_CODEX_WORKDIR,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
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
          new Error(
            `Codex CLI 执行失败 (退出码: ${code})${stderr ? `\n${stderr}` : ""}`
          )
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
          // Ignore non-JSON lines. Codex may emit banner or warning lines on stdout.
        }
      }

      if (!lastAgentMessage) {
        reject(
          new Error(
            `Codex CLI 没有返回可解析的 agent_message。${stderr ? `\n${stderr}` : ""}`
          )
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

async function askCodex(conversation, message) {
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

    if (CODEX_MODEL) {
      args.push("-m", CODEX_MODEL);
    }

    args.push(codexSessionId, buildCodexResumePrompt(message));
    result = await runCodex(args, { cwd: codexWorkdir });
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
      CODEX_SANDBOX,
    ];

    if (CODEX_MODEL) {
      args.push("-m", CODEX_MODEL);
    }

    args.push("-C", codexWorkdir);
    args.push(buildCodexNewSessionPrompt(conversation, message));
    result = await runCodex(args, { cwd: codexWorkdir });
  }

  await sleep(200);
  const recentCodexSessions = await loadRecentCodexSessions();
  const sessionId = codexSessionId || result.threadId || recentCodexSessions[0]?.id || null;
  const session = recentCodexSessions.find((item) => item.id === sessionId) || null;

  return {
    text: result.text,
    codexWorkdir,
    codexSessionId: sessionId,
    codexThreadName: session?.threadName || conversation?.codexThreadName || null,
    codexSessionUpdatedAt: session?.updatedAt || null,
    recentCodexSessions,
  };
}

async function buildReply(conversation, message) {
  if (currentMode === "openai" && OPENAI_API_KEY) {
    return { text: await askOpenAI(conversation) };
  }

  if (currentMode === "codex") {
    return askCodex(conversation, message);
  }

  await sleep(300);
  return {
    text: [
      `已收到你的消息：${message.text}`,
      "",
      `这是 ${AGENT_NAME} 在 AgentHub 里的最小版自动回复。`,
      "如果你配置了 OPENAI_API_KEY，并把 AGENT_MODE 改成 openai，它就会改为真实模型回复。",
    ].join("\n"),
  };
}

function connect() {
  // On macOS with system-wide proxy tooling enabled, the default HTTP/WebSocket
  // agent can be hijacked by local proxy software and cause EBADF on outbound
  // Hub connections. We want the local Agent to dial the Hub directly.
  const ws = new WebSocket(HUB_WS_URL, { agent: false });

  ws.on("open", async () => {
    authFailed = false;
    console.log(`Connected to hub: ${HUB_WS_URL}`);
    const recentCodexSessions = await loadRecentCodexSessions();
    sendJson(ws, {
      type: "hello",
      role: "agent",
      agentId: AGENT_ID,
      name: AGENT_NAME,
      deviceId: DEVICE_ID,
      deviceName: DEVICE_NAME,
      mode: currentMode,
      token: AGENT_TOKEN,
      recentCodexSessions,
      defaultCodexWorkdir: DEFAULT_CODEX_WORKDIR,
      workdirRoots: AGENT_WORKDIR_ROOTS,
    });
  });

  ws.on("message", async (raw) => {
    let payload;

    try {
      payload = JSON.parse(String(raw));

      if (payload.type === "auth_required" || payload.type === "error") {
        authFailed = true;
        console.error(payload.message || "Hub 鉴权失败");
        return;
      }

      if (payload.type === "list_agent_directories") {
        const requestId = String(payload.requestId || "").trim();

        try {
          const result = await listDirectories(payload.path);
          sendJson(ws, {
            type: "agent_directory_list",
            agentId: AGENT_ID,
            appClientId: payload.appClientId || null,
            requestId,
            path: result.path,
            parentPath: result.parentPath,
            roots: result.roots,
            entries: result.entries,
          });
        } catch (error) {
          sendJson(ws, {
            type: "agent_directory_list",
            agentId: AGENT_ID,
            appClientId: payload.appClientId || null,
            requestId,
            path: String(payload.path || DEFAULT_CODEX_WORKDIR),
            parentPath: null,
            roots: AGENT_WORKDIR_ROOTS,
            entries: [],
            error: error.message || "读取目录失败",
          });
        }
        return;
      }

      if (payload.type !== "deliver_user_message") {
        return;
      }

      const messageId = payload.message?.id;
      if (!messageId || processedMessages.has(messageId)) {
        return;
      }

      processedMessages.add(messageId);

      sendJson(ws, {
        type: "agent_status",
        conversationId: payload.conversationId,
        replyTo: messageId,
        status: "processing",
      });

      const reply = await buildReply(payload.conversation, payload.message);

      if (reply.recentCodexSessions) {
        sendJson(ws, {
          type: "agent_codex_sessions",
          agentId: AGENT_ID,
          sessions: reply.recentCodexSessions,
        });
      }

      sendJson(ws, {
        type: "agent_message",
        conversationId: payload.conversationId,
        agentId: AGENT_ID,
        replyTo: messageId,
        text: reply.text,
        codexWorkdir: reply.codexWorkdir || null,
        codexSessionId: reply.codexSessionId || null,
        codexThreadName: reply.codexThreadName || null,
        codexSessionUpdatedAt: reply.codexSessionUpdatedAt || null,
      });
    } catch (error) {
      console.error("Agent failed to process message:", error);

      if (payload?.conversationId && payload?.message?.id) {
        sendJson(ws, {
          type: "agent_status",
          conversationId: payload.conversationId,
          replyTo: payload.message.id,
          status: "failed",
          error: error.message || "处理失败",
        });
      }
    }
  });

  ws.on("close", () => {
    const retryDelay = authFailed ? 10000 : 2000;
    console.log(
      authFailed
        ? "Hub 鉴权失败，10s 后重试。请检查 AGENT_TOKEN。"
        : "Hub connection closed, retrying in 2s..."
    );
    setTimeout(connect, retryDelay);
  });

  ws.on("error", (error) => {
    console.error("Hub connection error:", error.message);
  });
}

connect();
