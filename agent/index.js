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
const CODEX_SANDBOX = runtimeConfig.codexSandbox || "danger-full-access";
const CODEX_HOME = runtimeConfig.codexHome;
const CODEX_RUNTIME_ENV = {
  ...process.env,
  CODEX_HOME,
};
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
  "claude",
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

async function fetchHubJson(pathValue, init = {}) {
  const response = await fetch(`${HUB_ORIGIN}${pathValue}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "x-agenthub-token": AGENT_TOKEN,
      ...(init.headers || {}),
    },
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      payload?.message || `读取 Hub 资源失败：${response.status}`
    );
  }

  return payload;
}

async function buildAttachmentContext(attachment) {
  const resourceId = normalizeText(attachment?.resourceId);
  if (!resourceId) {
    return "";
  }

  const name = normalizeText(attachment?.name) || resourceId;
  const baseMeta = [
    `名称：${name}`,
    attachment?.mime ? `类型：${attachment.mime}` : null,
    Number.isFinite(Number(attachment?.size)) ? `大小：${attachment.size} bytes` : null,
    Number.isFinite(Number(attachment?.lineCount)) ? `行数：${attachment.lineCount}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const shouldReadFull = Number(attachment?.size || 0) > 0 && Number(attachment.size) <= 64 * 1024;
  const primaryMode = shouldReadFull ? "full" : "head";
  const primary = await fetchHubJson(
    `/api/resources/${encodeURIComponent(resourceId)}/content?mode=${primaryMode}&limitLines=120`
  );
  let body = String(primary?.content || "").trim();

  if (!shouldReadFull && Number(attachment?.lineCount || 0) > 120) {
    const tail = await fetchHubJson(
      `/api/resources/${encodeURIComponent(resourceId)}/content?mode=tail&limitLines=80`
    );
    const tailBody = String(tail?.content || "").trim();
    if (tailBody) {
      body = [body, "[末尾片段]", tailBody].filter(Boolean).join("\n\n");
    }
  }

  return [
    `[文本资源] ${baseMeta}`,
    body || String(attachment?.previewText || "").trim() || "资源正文暂时为空。",
  ]
    .filter(Boolean)
    .join("\n");
}

async function enrichIncomingMessage(message, conversation) {
  const attachments = Array.isArray(message?.attachments) ? message.attachments.filter(Boolean) : [];
  if (attachments.length === 0) {
    return {
      message,
      conversation,
    };
  }

  const attachmentSections = [];
  for (const attachment of attachments) {
    try {
      const section = await buildAttachmentContext(attachment);
      if (section) {
        attachmentSections.push(section);
      }
    } catch (error) {
      attachmentSections.push(
        `[文本资源] ${normalizeText(attachment?.name) || "未命名资源"}\n读取失败：${error.message || "未知错误"}`
      );
    }
  }

  if (attachmentSections.length === 0) {
    return {
      message,
      conversation,
    };
  }

  const composedText = [
    normalizeText(message?.text),
    "以下是用户附带的文本资源，请结合这些材料继续处理：",
    attachmentSections.join("\n\n"),
  ]
    .filter(Boolean)
    .join("\n\n");

  const nextMessage = {
    ...message,
    composedText,
  };
  const nextConversation = {
    ...conversation,
    messages: Array.isArray(conversation?.messages)
      ? conversation.messages.map((item) =>
          item?.id === message?.id ? { ...item, text: composedText } : item
        )
      : [],
  };

  return {
    message: nextMessage,
    conversation: nextConversation,
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

function getCodexSessionHomes() {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const xdgData = process.env.XDG_DATA_HOME || join(home, ".local", "share");
  const xdgConfig = process.env.XDG_CONFIG_HOME || join(home, ".config");
  const paths = [
    CODEX_HOME,
    join(home, ".codex"),
    join(home, ".agenthub", "codex-homes", AGENT_ID),
    join(xdgData, "codex"),
    join(xdgConfig, "codex"),
  ];

  if (process.platform === "darwin") {
    paths.push(join(home, "Library", "Application Support", "codex"));
  }

  return [...new Set(paths.filter(Boolean).map((p) => resolve(p)))];
}

function getCodexSessionIndexPaths() {
  return getCodexSessionHomes().map((codexHome) => join(codexHome, "session_index.jsonl"));
}

function getCodexSessionRoots() {
  return getCodexSessionHomes().map((codexHome) => join(codexHome, "sessions"));
}

function getCodexSessionIndexEntries() {
  return getCodexSessionHomes().map((codexHome) => ({
    codexHome,
    indexPath: join(codexHome, "session_index.jsonl"),
  }));
}

function getCodexSessionRootEntries() {
  return getCodexSessionHomes().map((codexHome) => ({
    codexHome,
    root: join(codexHome, "sessions"),
  }));
}

function getConversationCodexHome(conversation) {
  const candidate = normalizeText(conversation?.codexHome);
  if (!candidate) {
    return CODEX_HOME;
  }

  const resolved = resolve(candidate);
  return getCodexSessionHomes().includes(resolved) ? resolved : CODEX_HOME;
}

function parseSessionIndex(raw, codexHome) {
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
        const threadName = sanitizeSessionTitle(item.thread_name || item.threadName);
        return {
          id: String(item.id),
          threadName: threadName || "未命名 Session",
          updatedAt: item.updated_at || item.updatedAt || null,
          codexHome,
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function isUsableSessionTitle(value) {
  const text = normalizeText(value);
  if (!text) {
    return false;
  }

  return ![
    "<INSTRUCTIONS>",
    "<environment_context>",
    "<permissions instructions>",
    "AGENTS.md instructions",
    "Filesystem sandboxing defines",
    "你是 AgentHub 里的一个数字员工",
  ].some((pattern) => text.includes(pattern));
}

function sanitizeSessionTitle(value) {
  const title = extractSessionTitle(value);
  return isUsableSessionTitle(title) ? title : "";
}

function extractSessionTitle(value) {
  const text = normalizeText(value);
  if (!text) {
    return "";
  }

  const latestMessageMatch = text.match(/当前用户最新消息：\s*([\s\S]*?)(?:\n对话历史：|$)/);
  if (latestMessageMatch?.[1]) {
    const latestMessage = normalizeText(latestMessageMatch[1]);
    if (latestMessage) {
      return latestMessage.length > 80 ? `${latestMessage.slice(0, 80)}...` : latestMessage;
    }
  }

  const chunks = text
    .split(/\n{2,}/)
    .map((item) => normalizeText(item))
    .filter(Boolean);
  const title = chunks[chunks.length - 1] || text;
  return title.length > 80 ? `${title.slice(0, 80)}...` : title;
}

function extractTextContent(content) {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((item) => item?.text || item?.input_text || item?.output_text || "")
    .filter(Boolean)
    .join("\n");
}

async function parseSessionFile(filePath, codexHome) {
  const raw = await fs.readFile(filePath, "utf8");
  const fallbackId =
    basename(filePath).match(/([0-9a-f]{8}-[0-9a-f-]{27,})\.jsonl$/i)?.[1] || "";
  let sessionId = fallbackId;
  let threadName = "";
  let updatedAt = "";

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }

    if (entry.timestamp && (!updatedAt || new Date(entry.timestamp) > new Date(updatedAt))) {
      updatedAt = entry.timestamp;
    }

    if (entry.type === "session_meta") {
      sessionId = String(entry.payload?.id || sessionId);
      threadName =
        sanitizeSessionTitle(entry.payload?.thread_name || entry.payload?.threadName) ||
        threadName;
      updatedAt = entry.payload?.timestamp || updatedAt;
      continue;
    }

    if (entry.payload?.type === "user_message") {
      threadName = sanitizeSessionTitle(entry.payload.message) || threadName;
      continue;
    }

    if (!threadName && entry.payload?.type === "message" && entry.payload?.role === "user") {
      threadName = sanitizeSessionTitle(extractTextContent(entry.payload.content));
    }
  }

  if (!sessionId) {
    return null;
  }

  return {
    id: sessionId,
    threadName: threadName || "未命名 Session",
    updatedAt: updatedAt || null,
    codexHome,
  };
}

async function listSessionFiles(root, codexHome) {
  try {
    const entries = await fs.readdir(root, {
      recursive: true,
      withFileTypes: true,
    });
    const filePaths = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => join(entry.parentPath || entry.path || root, entry.name));

    return Promise.all(
      filePaths.map(async (filePath) => {
        try {
          const stats = await fs.stat(filePath);
          return { filePath, mtimeMs: stats.mtimeMs, codexHome };
        } catch {
          return { filePath, mtimeMs: 0, codexHome };
        }
      })
    );
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn(`Failed to scan Codex session directory at ${root}:`, error.message);
    }
    return [];
  }
}

async function loadRecentCodexSessions() {
  if (!CODEX_BIN) {
    return [];
  }

  const allSessions = [];

  for (const { codexHome, indexPath } of getCodexSessionIndexEntries()) {
    try {
      const raw = await fs.readFile(indexPath, "utf8");
      const sessions = parseSessionIndex(raw, codexHome);
      allSessions.push(...sessions);
    } catch (error) {
      if (error.code !== "ENOENT") {
        console.warn(`Failed to read Codex session index at ${indexPath}:`, error.message);
      }
    }
  }

  const sessionFiles = (
    await Promise.all(
      getCodexSessionRootEntries().map(({ root, codexHome }) =>
        listSessionFiles(root, codexHome)
      )
    )
  ).flat();

  const recentFiles = sessionFiles
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, MAX_RECENT_CODEX_SESSIONS * 4);
  for (const { filePath, codexHome } of recentFiles) {
    try {
      const session = await parseSessionFile(filePath, codexHome);
      if (session) {
        allSessions.push(session);
      }
    } catch (error) {
      console.warn(`Failed to parse Codex session file at ${filePath}:`, error.message);
    }
  }

  // Deduplicate by session id, keep the most recent entry
  const sessionMap = new Map();
  for (const session of allSessions) {
    const existing = sessionMap.get(session.id);
    if (!existing || new Date(session.updatedAt || 0) > new Date(existing.updatedAt || 0)) {
      sessionMap.set(session.id, session);
    }
  }

  return [...sessionMap.values()]
    .sort((left, right) => {
      const leftTime = new Date(left.updatedAt || 0).getTime();
      const rightTime = new Date(right.updatedAt || 0).getTime();
      return rightTime - leftTime;
    })
    .slice(0, MAX_RECENT_CODEX_SESSIONS);
}

// Log session index search paths at startup for diagnostics
if (currentMode === "codex") {
  const sessionPaths = getCodexSessionIndexPaths();
  console.log("Codex session index search paths:");
  for (const p of sessionPaths) {
    try {
      await fs.access(p);
      console.log(`  [FOUND] ${p}`);
    } catch {
      console.log(`  [  -  ] ${p}`);
    }
  }
  console.log("Codex session file search roots:");
  for (const p of getCodexSessionRoots()) {
    try {
      await fs.access(p);
      console.log(`  [FOUND] ${p}`);
    } catch {
      console.log(`  [  -  ] ${p}`);
    }
  }
}

const runtimeAdapter = createRuntimeAdapter({
  mode: currentMode,
  agentName: AGENT_NAME,
  systemPrompt: AGENT_PROMPT,
  openaiApiKey: OPENAI_API_KEY,
  openaiModel: OPENAI_MODEL,
  claudeModel: runtimeConfig.claudeModel || "claude-opus-4-6",
  codexBin: CODEX_BIN,
  codexModel: CODEX_MODEL,
  codexSandbox: CODEX_SANDBOX,
  defaultWorkdir: DEFAULT_CODEX_WORKDIR,
  getConversationWorkdir,
  getConversationCodexHome,
  loadRecentCodexSessions,
  sleep,
  env: CODEX_RUNTIME_ENV,
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

let lastSyncedSessionHash = "";

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

// Periodically sync Codex sessions so the Hub always has fresh data
async function syncCodexSessions(ws) {
  try {
    const sessions = await loadRecentCodexSessions();
    const hash = JSON.stringify(sessions.map((s) => s.id).sort());
    if (hash === lastSyncedSessionHash) {
      return;
    }
    lastSyncedSessionHash = hash;
    sendJson(ws, {
      type: "agent_codex_sessions",
      agentId: AGENT_ID,
      sessions,
    });
  } catch {
    // Ignore sync errors
  }
}

function startHeartbeat(ws) {
  stopHeartbeat();
  sendHeartbeat(ws);
  syncCodexSessions(ws);
  heartbeatTimer = setInterval(() => {
    sendHeartbeat(ws);
    syncCodexSessions(ws);
  }, AGENT_HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

// Handle manager_query: the Hub delegates an AI Manager request to this agent.
// We build a synthetic conversation with the manager's system prompt + runtime context,
// then invoke the runtime adapter to generate a reply.
async function handleManagerQuery(payload) {
  const conversationId = normalizeText(payload.conversationId);
  const userText = normalizeText(payload.message?.text);

  if (!conversationId || !userText) {
    return;
  }

  const systemPrompt = normalizeText(payload.systemPrompt);
  const runtimeContext = normalizeText(payload.runtimeContext);
  const fullSystemPrompt = [systemPrompt, runtimeContext].filter(Boolean).join("\n\n");
  const tools = Array.isArray(payload.tools) ? payload.tools : [];

  // Build messages from conversation history
  const historyMessages = (payload.conversation?.messages || []).slice(-10);
  const claudeMessages = [];
  for (const msg of historyMessages) {
    if (msg.role === "assistant") {
      claudeMessages.push({ role: "assistant", content: msg.text || "" });
    } else if (msg.role === "user") {
      claudeMessages.push({ role: "user", content: msg.text || "" });
    }
  }
  // Ensure the latest user message is included
  const lastMsg = claudeMessages[claudeMessages.length - 1];
  if (!lastMsg || lastMsg.role !== "user" || lastMsg.content !== userText) {
    claudeMessages.push({ role: "user", content: userText });
  }

  // Convert OpenAI-style tools to Claude tools format
  const claudeTools = tools.map((t) => {
    const fn = t.function || t;
    return {
      name: fn.name,
      description: fn.description || "",
      input_schema: fn.parameters || { type: "object", properties: {} },
    };
  });

  // Resolve API credentials from env or MODELS_JSON
  let CLAUDE_API_KEY = process.env.ANTHROPIC_API_KEY || "";
  let CLAUDE_BASE_URL = process.env.ANTHROPIC_BASE_URL || "";
  if (!CLAUDE_API_KEY) {
    try {
      const models = JSON.parse(process.env.MODELS_JSON || "[]");
      const entry = (Array.isArray(models) ? models : []).find(
        (m) => m.provider === "anthropic" && m.apiKey
      );
      if (entry) {
        CLAUDE_API_KEY = entry.apiKey;
        CLAUDE_BASE_URL = CLAUDE_BASE_URL || entry.baseURL || "https://api.anthropic.com";
      }
    } catch {}
  }
  if (!CLAUDE_BASE_URL) CLAUDE_BASE_URL = "https://api.anthropic.com";
  const CLAUDE_MODEL = runtimeConfig.claudeModel || "claude-opus-4-6";
  const MAX_TOOL_LOOPS = 5;

  try {
    let messages = claudeMessages;
    let finalText = "";
    let toolCalls = [];

    for (let loop = 0; loop < MAX_TOOL_LOOPS; loop++) {
      const requestBody = {
        model: CLAUDE_MODEL,
        max_tokens: 4096,
        system: fullSystemPrompt,
        messages,
      };
      if (claudeTools.length > 0) {
        requestBody.tools = claudeTools;
      }
      console.log(`[Manager] Calling Claude API with ${claudeTools.length} tools, ${messages.length} messages`);

      const response = await fetch(`${CLAUDE_BASE_URL}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": CLAUDE_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Claude API failed: ${response.status} ${errorText}`);
      }

      const json = await response.json();
      const content = json.content || [];
      console.log(`[Manager] Claude stop_reason=${json.stop_reason}, content_types=${content.map(b => b.type).join(",")}`);

      // Extract text blocks
      const textBlocks = content.filter((b) => b.type === "text").map((b) => b.text);
      if (textBlocks.length > 0) {
        finalText = textBlocks.join("\n");
      }

      // Check for tool_use blocks
      const toolUseBlocks = content.filter((b) => b.type === "tool_use");
      if (toolUseBlocks.length === 0 || json.stop_reason !== "tool_use") {
        // No tool calls, we're done
        break;
      }

      // Collect tool calls to send back to Hub for execution
      for (const block of toolUseBlocks) {
        toolCalls.push({ name: block.name, arguments: block.input || {} });
      }

      // For tool execution, we need to send tool_calls to Hub and wait for results.
      // But since we don't have a back-channel for that, we'll just report the tool calls
      // and let Hub handle them. Break out of the loop.
      break;
    }

    sendJson(currentWs, {
      type: "agent_message",
      conversationId,
      agentId: AGENT_ID,
      text: finalText || "收到",
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    });
  } catch (error) {
    sendJson(currentWs, {
      type: "agent_message",
      conversationId,
      agentId: AGENT_ID,
      text: `经理 Agent 处理失败：${error.message}`,
    });
  }
}

let currentWs = null;

function connect() {
  // On macOS with system-wide proxy tooling enabled, the default HTTP/WebSocket
  // agent can be hijacked by local proxy software and cause EBADF on outbound
  // Hub connections. We want the local Agent to dial the Hub directly.
  const ws = new WebSocket(HUB_WS_URL, { agent: false });

  ws.on("open", async () => {
    authFailed = false;
    currentWs = ws;
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

        // Forward approval decision to the active Codex runtime process
        if (runtimeAdapter.resolveApproval) {
          runtimeAdapter.resolveApproval(decision);
        }
        return;
      }

      // Handle user intervention message sent to an in-progress task
      if (payload.type === "intervene_task") {
        const activeRun = runtimeAdapter.getActiveRun?.();
        if (activeRun && normalizeText(payload.text)) {
          const interventionAccepted = activeRun.sendInput(normalizeText(payload.text) + "\n");
          sendJson(ws, buildProgressEvent(
            {
              conversationId: normalizeText(payload.conversationId),
              taskId: runtimeState.currentTaskId,
            },
            {
              status: "in_progress",
              runId: runtimeState.currentRunId,
              runStatus: "running",
              summary: interventionAccepted === false
                ? "当前 Codex 执行通道不支持运行中输入，请等待本轮完成后继续补充。"
                : `收到干预指令：${normalizeText(payload.text)}`,
            }
          ));
        }
        return;
      }

      // Handle manager_query: AI Manager delegates to this agent
      if (payload.type === "manager_query") {
        handleManagerQuery(payload);
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

      const runtimeInput = await enrichIncomingMessage(payload.message, payload.conversation);

      // Progress callback: stream intermediate updates to Hub in real-time
      const onProgress = (info) => {
        sendJson(ws, buildProgressEvent(
          {
            conversationId: payload.conversationId,
            replyTo: messageId,
            task: taskPayload,
          },
          {
            status: "in_progress",
            runId,
            runStatus: "running",
            summary: info.summary || info.fullText || "执行中...",
          }
        ));
      };

      // Approval callback: when Codex needs human confirmation, push to Hub
      const onApprovalNeeded = (info) => {
        updateRuntimeState({
          status: "waiting_approval",
          currentTaskId: taskId,
          currentRunId: runId,
          summary: `等待审批：${info.reason}`,
        });
        sendJson(ws, {
          type: "approval.requested",
          taskId,
          runId,
          reason: info.reason || "Codex 需要确认才能继续",
          scope: info.scope || null,
          requestedAction: info.requestedAction || null,
          riskLevel: info.riskLevel || "medium",
        });
      };

      const reply = await runtimeAdapter.reply({
        conversation: runtimeInput.conversation,
        message: runtimeInput.message,
        onProgress,
        onApprovalNeeded,
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
        codexHome: reply.codexHome || null,
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
