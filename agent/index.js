import "dotenv/config";
import WebSocket from "ws";
import { promises as fs } from "fs";
import { basename, join, resolve, sep } from "path";
import {
  isPathWithinRoots,
  loadAgentRuntimeConfig,
  loadConfiguredWorkspaceCatalog,
  resolvePathLike,
} from "./config.js";
import { createRuntimeAdapter } from "./providers/index.js";

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeWorkspaceKind(value) {
  const normalized = normalizeText(value).toLowerCase();
  return normalized || "repo";
}

const runtimeConfig = await loadAgentRuntimeConfig();

const HUB_ORIGIN = runtimeConfig.hubOrigin || "http://localhost:3000";
const HUB_WS_URL = HUB_ORIGIN.replace(/^http/, "ws") + "/ws";
const AGENT_ID = runtimeConfig.agentId || "local-ai";
const AGENT_NAME = runtimeConfig.agentName || "Digital Employee";
const AGENT_MODE = runtimeConfig.agentMode || "echo";
const AGENT_TOKEN = runtimeConfig.agentToken || "";
const DEVICE_ID = normalizeText(runtimeConfig.deviceId);
const DEVICE_NAME = normalizeText(runtimeConfig.deviceName) || DEVICE_ID;
const AGENT_DEFAULT_WORKSPACE_KIND =
  normalizeWorkspaceKind(runtimeConfig.defaultWorkspaceKind) || "repo";
const AGENT_HEARTBEAT_INTERVAL_MS = Math.max(
  5000,
  Number(runtimeConfig.heartbeatIntervalMs || 15000)
);
const AGENT_VERSION = normalizeText(runtimeConfig.agentVersion) || "1.0.0";
const AGENT_PROMPT =
  runtimeConfig.agentPrompt ||
  "你是 AgentHub 里的一个数字员工，要用简洁、可靠、可执行的方式帮助用户推进任务。";
const OPENAI_API_KEY = runtimeConfig.openaiApiKey || "";
const OPENAI_MODEL = runtimeConfig.openaiModel || "gpt-5";
const CODEX_BIN = runtimeConfig.codexBin || "codex";
const CODEX_WORKDIR = runtimeConfig.codexWorkdir || process.cwd();
const CODEX_MODEL = runtimeConfig.codexModel || "";
const CODEX_SANDBOX = runtimeConfig.codexSandbox || "read-only";
const CODEX_HOME = runtimeConfig.codexHome;
const CODEX_SESSION_INDEX = join(CODEX_HOME, "session_index.jsonl");
const MAX_RECENT_CODEX_SESSIONS = 12;
const AGENT_WORKDIR_ROOTS = (Array.isArray(runtimeConfig.workdirRoots)
  ? runtimeConfig.workdirRoots
  : [CODEX_WORKDIR]
)
  .map((value) => resolvePathLike(value))
  .filter(Boolean)
  .map((value) => resolve(value))
  .filter((value, index, all) => all.indexOf(value) === index);
const DEFAULT_CODEX_WORKDIR = resolve(CODEX_WORKDIR);

const processedMessages = new Set();
let authFailed = false;
let heartbeatTimer = null;
const runtimeState = {
  status: "idle",
  currentTaskId: null,
  currentRunId: null,
  summary: null,
};
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

function buildWorkspaceId(pathValue) {
  const seed = `${DEVICE_ID}-${pathValue}`;
  const slug = normalizeText(seed)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `workspace-${slug || "default"}`;
}

function buildWorkspaceName(pathValue) {
  return basename(pathValue) || pathValue || "Workspace";
}

function isWithinAllowedRoot(targetPath) {
  return isPathWithinRoots(targetPath, AGENT_WORKDIR_ROOTS);
}

function getConversationWorkdir(conversation) {
  const candidate = normalizeWorkdir(conversation?.codexWorkdir || DEFAULT_CODEX_WORKDIR);
  return isWithinAllowedRoot(candidate) ? candidate : DEFAULT_CODEX_WORKDIR;
}

function buildProgressEvent(payload, overrides = {}) {
  const taskId = normalizeText(payload?.task?.id || payload?.taskId);
  const sourceMessageId = normalizeText(
    payload?.task?.sourceMessageId || payload?.sourceMessageId || payload?.replyTo
  );
  const runId =
    normalizeText(overrides.runId || payload?.task?.runId) ||
    (taskId ? `run-${taskId}` : null);
  return {
    type: "task_progress",
    taskId: taskId || null,
    runId,
    conversationId: normalizeText(payload?.conversationId) || null,
    replyTo: sourceMessageId || null,
    agentId: AGENT_ID,
    employeeId: AGENT_ID,
    runStatus: overrides.runStatus || null,
    status: overrides.status || null,
    summary: normalizeText(overrides.summary) || null,
    error: normalizeText(overrides.error) || null,
    outputRef: normalizeText(overrides.outputRef) || null,
    updatedAt: new Date().toISOString(),
  };
}

function normalizeWorkspaceRecord(workspace, index = 0) {
  const pathValue = normalizeText(workspace?.path || workspace?.workdir);
  if (!pathValue) {
    return null;
  }

  const resolvedPath = normalizeWorkdir(pathValue);
  if (!isWithinAllowedRoot(resolvedPath)) {
    return null;
  }

  const tags = Array.isArray(workspace?.tags)
    ? workspace.tags.map((tag) => normalizeText(tag)).filter(Boolean)
    : [];
  const runtimeHints = Array.isArray(workspace?.runtimeHints)
    ? workspace.runtimeHints.map((hint) => normalizeText(hint)).filter(Boolean)
    : [];
  const effectiveRuntimeHints =
    runtimeHints.length > 0 ? runtimeHints : currentMode ? [currentMode] : [];

  return {
    id: normalizeText(workspace?.id) || buildWorkspaceId(resolvedPath),
    name: normalizeText(workspace?.name) || buildWorkspaceName(resolvedPath),
    path: resolvedPath,
    kind: normalizeWorkspaceKind(workspace?.kind || AGENT_DEFAULT_WORKSPACE_KIND),
    description: normalizeText(workspace?.description) || null,
    tags: [...new Set(tags)],
    runtimeHints: [...new Set(effectiveRuntimeHints)],
    defaultEmployeeId: AGENT_ID,
    ordinal: index,
  };
}

function buildDefaultWorkspaceCatalog() {
  return [
    normalizeWorkspaceRecord(
      {
        id: buildWorkspaceId(DEFAULT_CODEX_WORKDIR),
        name: buildWorkspaceName(DEFAULT_CODEX_WORKDIR),
        path: DEFAULT_CODEX_WORKDIR,
        kind: AGENT_DEFAULT_WORKSPACE_KIND,
        description: "当前数字员工的默认工作目录。",
      },
      0
    ),
  ].filter(Boolean);
}

async function loadDeclaredWorkspaces() {
  try {
    const { items: sourceItems, sourceLabel } = await loadConfiguredWorkspaceCatalog(runtimeConfig);
    const skippedPaths = [];
    const workspaces = sourceItems
      .map((workspace, index) => {
        const record = normalizeWorkspaceRecord(workspace, index);
        if (!record && normalizeText(workspace?.path || workspace?.workdir)) {
          skippedPaths.push(resolvePathLike(workspace?.path || workspace?.workdir));
        }
        return record;
      })
      .filter(Boolean);

    if (skippedPaths.length > 0) {
      console.warn(
        `Skipped ${skippedPaths.length} workspace(s) outside allowed roots from ${sourceLabel}: ${skippedPaths.join(", ")}`
      );
    }

    if (workspaces.length > 0) {
      return workspaces;
    }
  } catch (error) {
    console.warn("Failed to load agent workspaces:", error.message);
  }

  return buildDefaultWorkspaceCatalog();
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

const runtimeAdapter = createRuntimeAdapter({
  mode: currentMode,
  agentName: AGENT_NAME,
  systemPrompt: AGENT_PROMPT,
  openaiApiKey: OPENAI_API_KEY,
  openaiModel: OPENAI_MODEL,
  codexBin: CODEX_BIN,
  codexModel: CODEX_MODEL,
  codexSandbox: CODEX_SANDBOX,
  defaultWorkdir: DEFAULT_CODEX_WORKDIR,
  getConversationWorkdir,
  loadRecentCodexSessions,
  sleep,
  env: process.env,
});

const agentCapabilities = [
  "direct_chat",
  "report_progress",
  "declare_workspaces",
  ...(AGENT_WORKDIR_ROOTS.length > 0 ? ["browse_directories"] : []),
  ...((runtimeAdapter?.capabilities || []).filter(Boolean)),
].filter((value, index, all) => all.indexOf(value) === index);

function sendJson(ws, payload) {
  if (ws.readyState !== 1) {
    return;
  }
  ws.send(JSON.stringify(payload));
}

function updateRuntimeState(patch = {}) {
  Object.assign(runtimeState, patch);
}

function sendHeartbeat(ws) {
  sendJson(ws, {
    type: "agent_heartbeat",
    agentId: AGENT_ID,
    employeeId: AGENT_ID,
    status: runtimeState.status,
    currentTaskId: runtimeState.currentTaskId,
    currentRunId: runtimeState.currentRunId,
    summary: runtimeState.summary,
    updatedAt: new Date().toISOString(),
  });
}

function startHeartbeat(ws) {
  stopHeartbeat();
  sendHeartbeat(ws);
  heartbeatTimer = setInterval(() => {
    sendHeartbeat(ws);
  }, AGENT_HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function connect() {
  // On macOS with system-wide proxy tooling enabled, the default HTTP/WebSocket
  // agent can be hijacked by local proxy software and cause EBADF on outbound
  // Hub connections. We want the local Agent to dial the Hub directly.
  const ws = new WebSocket(HUB_WS_URL, { agent: false });

  ws.on("open", async () => {
    authFailed = false;
    console.log(`Connected to hub: ${HUB_WS_URL}`);
    updateRuntimeState({
      status: "idle",
      currentTaskId: null,
      currentRunId: null,
      summary: "已连上 AgentHub，等待任务。",
    });
    const [runtimeRegistrationContext, workspaces] = await Promise.all([
      runtimeAdapter.getRegistrationContext?.() || {},
      loadDeclaredWorkspaces(),
    ]);
    sendJson(ws, {
      type: "employee.register",
      agentId: AGENT_ID,
      employeeId: AGENT_ID,
      name: AGENT_NAME,
      employeeName: AGENT_NAME,
      role: "agent",
      deviceId: DEVICE_ID,
      deviceName: DEVICE_NAME,
      mode: currentMode,
      runtime: currentMode,
      version: AGENT_VERSION,
      capabilities: agentCapabilities,
      token: AGENT_TOKEN,
      workdirRoots: AGENT_WORKDIR_ROOTS,
      workspaceHints: workspaces.map((workspace) => workspace.id),
      workspaces,
      ...runtimeRegistrationContext,
    });
    startHeartbeat(ws);
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

      if (payload.type === "approval_resolved") {
        const decision = normalizeText(payload.decision) || "approved";
        updateRuntimeState({
          status: decision === "approved" ? "busy" : "blocked",
          currentTaskId: normalizeText(payload.taskId) || runtimeState.currentTaskId,
          currentRunId: normalizeText(payload.runId) || runtimeState.currentRunId,
          summary:
            decision === "approved"
              ? `审批已通过，可以继续执行。${normalizeText(payload.note) || ""}`.trim()
              : `审批被拒绝：${normalizeText(payload.note) || "请等待进一步指示"}`,
        });
        return;
      }

      if (!["deliver_user_message", "task.assigned"].includes(payload.type)) {
        return;
      }

      const taskPayload = payload.task || null;
      const messageId = payload.message?.id;
      if (!messageId || processedMessages.has(messageId)) {
        return;
      }

      processedMessages.add(messageId);
      const taskId = normalizeText(taskPayload?.id) || null;
      const runId = taskId ? `run-${taskId}` : null;
      updateRuntimeState({
        status: "busy",
        currentTaskId: taskId,
        currentRunId: runId,
        summary: normalizeText(taskPayload?.title || payload.message?.text) || "正在处理任务",
      });

      sendJson(ws, {
        type: "agent_status",
        conversationId: payload.conversationId,
        replyTo: messageId,
        status: "processing",
      });
      sendJson(
        ws,
        buildProgressEvent(
          {
            conversationId: payload.conversationId,
            replyTo: messageId,
            task: taskPayload,
          },
          {
            status: "in_progress",
            runId,
            runStatus: "running",
            summary: `${AGENT_NAME} 已开始处理：${
              normalizeText(taskPayload?.title) || payload.message?.text || "新任务"
            }`,
          }
        )
      );

      const reply = await runtimeAdapter.reply({
        conversation: payload.conversation,
        message: payload.message,
      });

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
        taskId: taskPayload?.id || null,
        replyTo: messageId,
        text: reply.text,
        codexWorkdir: reply.codexWorkdir || null,
        codexSessionId: reply.codexSessionId || null,
        codexThreadName: reply.codexThreadName || null,
        codexSessionUpdatedAt: reply.codexSessionUpdatedAt || null,
      });
      sendJson(
        ws,
        buildProgressEvent(
          {
            conversationId: payload.conversationId,
            replyTo: messageId,
            task: taskPayload,
          },
          {
            status: "completed",
            runId,
            runStatus: "completed",
            summary: reply.text,
          }
        )
      );
      updateRuntimeState({
        status: "idle",
        currentTaskId: null,
        currentRunId: null,
        summary: `刚完成：${normalizeText(taskPayload?.title || payload.message?.text) || "任务"}`,
      });
    } catch (error) {
      console.error("Agent failed to process message:", error);

      if (payload?.conversationId && payload?.message?.id) {
        const taskId = normalizeText(payload?.task?.id) || null;
        const runId = taskId ? `run-${taskId}` : null;
        sendJson(ws, {
          type: "agent_status",
          conversationId: payload.conversationId,
          replyTo: payload.message.id,
          status: "failed",
          error: error.message || "处理失败",
        });
        sendJson(
          ws,
          buildProgressEvent(
            {
              conversationId: payload.conversationId,
              replyTo: payload.message.id,
              task: payload.task || null,
            },
            {
              status: "failed",
              runId,
              runStatus: "failed",
              summary: "任务执行失败",
              error: error.message || "处理失败",
            }
          )
        );
        updateRuntimeState({
          status: "blocked",
          currentTaskId: taskId,
          currentRunId: runId,
          summary: error.message || "任务执行失败",
        });
      }
    }
  });

  ws.on("close", () => {
    stopHeartbeat();
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
