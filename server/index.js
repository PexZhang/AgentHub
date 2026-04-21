import "dotenv/config";
import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import { buildManagerTaskDraft } from "./manager/task-draft.js";
import {
  buildManagerKnowledgePrompt,
  formatKnowledgeReply,
  loadManagerKnowledgeBase,
  searchManagerKnowledge,
} from "./manager/knowledge-base.js";
import {
  buildAttentionItems,
  formatApprovalListReply,
  formatEmployeeListReply,
  formatTaskListReply,
  formatWorkspaceListReply,
  getActiveTaskForAgent,
  summarizeEmployee,
} from "./manager/snapshot-formatters.js";
import { createManagerToolRegistry } from "./manager/tool-registry.js";
import {
  buildConversationTitle,
  normalizeDeviceId,
  normalizeDeviceName,
  normalizeText,
} from "./shared/domain-utils.js";
import { createStoreFromEnv } from "./store/create-store.js";
import {
  buildTaskStatusLabel,
  compareByRecency,
  formatRelativeMinutes,
  isActiveTaskStatus,
  isBlockedTaskStatus,
  isOlderThan,
  mapRunStatusToTaskStatus,
  normalizeCodexSessions,
  normalizeManagerState,
  normalizeRunStatus,
  normalizeTaskStatus,
  normalizeWorkspaceList,
  truncateText,
} from "./store/state-model.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const HOST = String(process.env.HOST || "").trim();
const APP_TOKEN = normalizeText(process.env.APP_TOKEN);
const AGENT_TOKEN = normalizeText(process.env.AGENT_TOKEN);
const MANAGER_PROVIDER = resolveManagerProvider();
const MANAGER_API_KEY = resolveManagerApiKey(MANAGER_PROVIDER);
const MANAGER_BASE_URL =
  normalizeText(process.env.MANAGER_BASE_URL) || defaultManagerBaseUrl(MANAGER_PROVIDER);
const MANAGER_MODEL = normalizeText(process.env.MANAGER_MODEL) || defaultManagerModel(MANAGER_PROVIDER);
const MANAGER_REASONING_EFFORT =
  normalizeText(process.env.MANAGER_REASONING_EFFORT) || "low";
const MANAGER_TEXT_VERBOSITY =
  normalizeText(process.env.MANAGER_TEXT_VERBOSITY) || "low";
const DEFAULT_MANAGER_REQUEST_TIMEOUT_MS = MANAGER_PROVIDER === "zhipu" ? 30000 : 15000;
const MANAGER_REQUEST_TIMEOUT_MS = Math.max(
  3000,
  Number(process.env.MANAGER_REQUEST_TIMEOUT_MS || DEFAULT_MANAGER_REQUEST_TIMEOUT_MS)
);
const MANAGER_MAX_TOOL_LOOPS = 6;
const SNAPSHOT_MANAGER_MESSAGE_LIMIT = Math.max(
  20,
  Number(process.env.SNAPSHOT_MANAGER_MESSAGE_LIMIT || 80)
);
const SNAPSHOT_CONVERSATION_MESSAGE_LIMIT = Math.max(
  40,
  Number(process.env.SNAPSHOT_CONVERSATION_MESSAGE_LIMIT || 120)
);
const STALE_TASK_MINUTES = 12;
const STALE_AGENT_MINUTES = 5;
const MANAGER_KNOWLEDGE_BASE = loadManagerKnowledgeBase();
const MANAGER_PROMPT = buildManagerPrompt();

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function resolveManagerProvider() {
  const explicitProvider = normalizeText(process.env.MANAGER_PROVIDER).toLowerCase();
  if (explicitProvider) {
    return explicitProvider;
  }

  if (
    normalizeText(
      process.env.MANAGER_ZHIPU_API_KEY ||
        process.env.ZHIPU_API_KEY ||
        process.env.BIGMODEL_API_KEY
    )
  ) {
    return "zhipu";
  }

  if (normalizeText(process.env.MANAGER_API_KEY)) {
    return "openai-compatible";
  }

  if (normalizeText(process.env.MANAGER_OPENAI_API_KEY || process.env.OPENAI_API_KEY)) {
    return "openai";
  }

  return "local";
}

function resolveManagerApiKey(provider) {
  if (provider === "openai") {
    return normalizeText(process.env.MANAGER_OPENAI_API_KEY || process.env.OPENAI_API_KEY);
  }

  if (provider === "zhipu") {
    return normalizeText(
      process.env.MANAGER_API_KEY ||
        process.env.MANAGER_ZHIPU_API_KEY ||
        process.env.ZHIPU_API_KEY ||
        process.env.BIGMODEL_API_KEY
    );
  }

  if (provider === "openai-compatible") {
    return normalizeText(process.env.MANAGER_API_KEY);
  }

  return "";
}

function defaultManagerBaseUrl(provider) {
  if (provider === "openai") {
    return "https://api.openai.com/v1";
  }

  if (provider === "zhipu") {
    return "https://open.bigmodel.cn/api/paas/v4";
  }

  if (provider === "openai-compatible") {
    return "https://api.openai.com/v1";
  }

  return "";
}

function defaultManagerModel(provider) {
  if (provider === "zhipu") {
    return "glm-4.7-flash";
  }

  if (provider === "openai-compatible") {
    return "gpt-4o-mini";
  }

  return "gpt-5.4-mini";
}

function buildManagerPrompt() {
  return [
    "你是 AgentHub 的 AI 总经理，不是普通客服，也不是底层员工本人。",
    "你的职责是把人的目标翻译成可执行任务，把员工状态翻译成经理汇报，并在必要时把人切到某位员工的直连。",
    "默认使用中文，语气像总经理给指挥官做工作汇报：直接、清楚、少废话，但不能冷。",
    "先回答问题，再给事实依据，最后在有必要时给下一步建议。",
    "除非用户在寒暄或明确询问，否则不要重复“我已经接管当前工作台”之类的固定开场。",
    "能用工具确认状态时不要猜；信息不够时要明确说缺什么，不要编造。",
    "当用户问“你是谁”“你能做什么”“怎么用你”时，直接回答身份和能力边界，不需要调用工具。",
    "当用户问具体怎么接入、接入步骤、要敲什么命令、怎么把新设备上的 Codex 连进来时，优先调用 get_onboarding_guide，直接给步骤和命令，不要只讲原则。",
    "当用户问平台规则、其他 Agent 怎么接入背后的规则、工作机制、经理职责边界、如何扩知识库或扩职责时，优先调用 search_manager_knowledge。",
    "当用户问现在最该关注什么、谁卡住了、谁需要介入、有哪些风险时，优先调用 list_attention_items。",
    "当用户问员工有哪些、谁在线、在线员工具体信息、某位员工现在在做什么时，优先调用 list_employees；若用户点名某位员工或追问细节，再调用 get_employee_status。",
    "当用户问某位员工为什么没接上、为什么离线、接入是否正常、是不是没有工作区或是不是停住时，优先调用 diagnose_employee_issue。",
    "当用户问某条任务的状态、最近进展、是否卡住时，优先调用 get_task_status；若用户问整体任务盘点，调用 list_tasks。",
    "当用户问有哪些目录、仓库或工作区可用时，调用 list_workspaces；如果要分派任务但工作区不明确，先调用 resolve_workspace_for_employee。",
    "当用户问待审批事项或风险时，调用 list_approvals；当用户明确表示同意、批准、拒绝时，必须调用 resolve_approval。",
    "当用户要求催办、补充要求、提醒员工汇报、让员工继续推进或先停一下时，优先调用 follow_up_with_employee。",
    "当用户要求切到和某个员工的对话时，必须调用 switch_to_employee_chat。",
    "当用户说的是泛称，例如 codex / claude / openai，而当前存在多个同类员工时，不要自己替他选；要明确要求他给出具体员工名。",
    "当你分派任务时，优先调用 assign_task_to_employee，并尽量给出清晰的 task_title 和 success_signal。",
    "如果用户问的是某个对象的详细信息，就展开该对象，不要只重复总览。",
    "如果用户是在追问上一轮结果，延续上下文回答，不要把对话重置成总览介绍。",
    "详情型回答优先包含：是谁、在哪台设备、用什么运行时、当前任务、当前状态、最近汇报、是否阻塞。",
    "多使用“员工、任务、工作区、设备、进度、阻塞、审批”这些业务词，不要暴露 JSON、函数名、工具名或系统内部实现。",
    "只有在目标员工、任务或工作区明显歧义时才追问，不要把选择题甩给用户。",
    buildManagerKnowledgePrompt(MANAGER_KNOWLEDGE_BASE),
  ].join("\n");
}

function isExpectedToken(expectedToken, actualToken) {
  if (!expectedToken) {
    return true;
  }

  return normalizeText(actualToken) === expectedToken;
}

function readBearerToken(request) {
  const authHeader = normalizeText(request.headers.authorization);
  if (authHeader.startsWith("Bearer ")) {
    return authHeader.slice("Bearer ".length).trim();
  }

  return normalizeText(request.headers["x-agenthub-token"]);
}

async function fetchJsonWithTimeout(url, init, timeoutMs = MANAGER_REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
    });
    const rawText = await response.text();

    if (!response.ok) {
      throw new Error(`AI经理模型请求失败: ${response.status} ${rawText}`);
    }

    return rawText ? JSON.parse(rawText) : {};
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`AI经理模型请求超时（>${timeoutMs}ms）`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

const store = createStoreFromEnv({
  managerProvider: MANAGER_PROVIDER,
  managerModel: MANAGER_MODEL,
  snapshotConversationMessageLimit: SNAPSHOT_CONVERSATION_MESSAGE_LIMIT,
  snapshotManagerMessageLimit: SNAPSHOT_MANAGER_MESSAGE_LIMIT,
});
await store.init();

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

const appClients = new Set();
const agentClients = new Map();
let lastKnownAppOrigin = "";

function sendJson(socket, payload) {
  if (socket.readyState !== 1) {
    return;
  }
  socket.send(JSON.stringify(payload));
}

function buildSnapshot() {
  return store.buildSnapshot(agentClients);
}

function normalizeHttpOrigin(value) {
  const normalized = normalizeText(value).replace(/\/+$/u, "");
  if (!normalized || !/^https?:\/\//iu.test(normalized)) {
    return "";
  }
  return normalized;
}

function getPreferredHubOrigin() {
  return (
    normalizeHttpOrigin(process.env.PUBLIC_HUB_URL || process.env.APP_PUBLIC_URL) ||
    normalizeHttpOrigin(lastKnownAppOrigin) ||
    `http://127.0.0.1:${PORT}`
  );
}

function buildOnboardingGuideReply(runtime = "codex") {
  const resolvedRuntime = normalizeText(runtime).toLowerCase() || "codex";
  const hubOrigin = getPreferredHubOrigin();

  if (resolvedRuntime !== "codex") {
    return [
      `当前这一版正式打通的是 Codex 接入；你现在可以先按 Codex 的 onboarding 方式接设备，Hub 地址用 ${hubOrigin}。`,
      "如果你后面要接 Claude 或别的运行时，我再给你补对应的启动器和接入命令。",
    ].join("\n\n");
  }

  return [
    "把一台新设备上的 Codex 员工接进来，直接按这 4 步做：",
    "1. 在目标设备上准备运行环境",
    [
      "```bash",
      "git clone https://github.com/PexZhang/AgentHub.git",
      "cd AgentHub",
      "npm install",
      "codex --version",
      "```",
    ].join("\n"),
    `2. 确认 Hub 地址和接入密钥\n- Hub 地址：\`${hubOrigin}\`\n- AGENT_TOKEN：到 Hub 所在机器的项目目录里查看 \`.env\`；如果你是按当前阿里云部署方式装的，通常可以执行 \`cd /opt/agenthub && grep '^AGENT_TOKEN=' .env\``,
    "3. 在目标设备上生成这位员工的配置",
    [
      "```bash",
      "npm run agent:onboard:codex -- \\",
      `  --hub ${hubOrigin} \\`,
      "  --agent-token <你的AGENT_TOKEN> \\",
      '  --device-name "Office Mac" \\',
      '  --agent-name "Codex Office" \\',
      "  --root ~/Codes \\",
      "  --doctor",
      "```",
    ].join("\n"),
    "4. 自检通过后启动员工",
    [
      "```bash",
      "npm run agent -- --config ~/.agenthub/employees/codex-office.json",
      "```",
    ].join("\n"),
    "补充说明：\n- 如果你想生成完就直接上线，把第 3 步末尾的 `--doctor` 改成 `--doctor --start`\n- 如果是一台 Windows 机器，把 `--root ~/Codes` 换成实际目录，比如 `--root D:\\\\Projects`\n- 如果同一台电脑要挂多个 Codex 员工，重复执行一遍 onboarding，只改 `--agent-name`，`--device-name` 保持同一台机器的名字",
  ].join("\n\n");
}

function findAppClient(clientId) {
  for (const client of appClients) {
    if (client.clientId === clientId) {
      return client;
    }
  }

  return null;
}

function broadcastSnapshot() {
  const payload = { type: "snapshot", data: buildSnapshot() };
  for (const client of appClients) {
    sendJson(client, payload);
  }
}

function resolveWorkspaceBinding(agentId, conversation) {
  const availableWorkspaces = store
    .listWorkspacesByEmployee(agentId)
    .sort(compareByRecency);
  const explicitWorkspaceId = normalizeText(conversation?.workspaceId);

  if (explicitWorkspaceId && store.getWorkspace(explicitWorkspaceId)) {
    return {
      workspaceId: explicitWorkspaceId,
      candidateWorkspaceIds: [],
    };
  }

  const codexWorkdir = normalizeText(conversation?.codexWorkdir);
  if (codexWorkdir) {
    const exactWorkspace = store.findWorkspaceByEmployeeAndPath(agentId, codexWorkdir);
    if (exactWorkspace) {
      return {
        workspaceId: exactWorkspace.id,
        candidateWorkspaceIds: [],
      };
    }
  }

  if (availableWorkspaces.length === 1) {
    return {
      workspaceId: availableWorkspaces[0].id,
      candidateWorkspaceIds: [],
    };
  }

  return {
    workspaceId: null,
    candidateWorkspaceIds: availableWorkspaces.map((workspace) => workspace.id),
  };
}

async function createTaskForUserMessage({
  conversation,
  message,
  agentId,
  agentConnection,
  taskDraft = null,
}) {
  const binding = resolveWorkspaceBinding(agentId, conversation);
  const now = new Date().toISOString();
  const draft = taskDraft || null;
  const task = await store.createTask({
    title: normalizeText(draft?.title) || buildConversationTitle(message.text, "新任务"),
    goal: normalizeText(draft?.goal) || message.text,
    status: agentClients.has(agentId) ? "assigned" : "queued",
    priority: "normal",
    workspaceId: binding.workspaceId,
    ownerEmployeeId: agentId,
    requestedBy: normalizeText(draft?.requestedBy) || "human",
    sourceConversationId: conversation.id,
    sourceMessageId: message.id,
    directConversationId: conversation.id,
    createdAt: now,
    updatedAt: now,
    latestSummary: agentClients.has(agentId)
      ? "任务已分派给数字员工，等待开始执行。"
      : "员工当前离线，任务已进入排队。",
    managerSummary: normalizeText(draft?.managerSummary) || null,
    successSignal: normalizeText(draft?.successSignal) || null,
    labels: Array.isArray(draft?.labels) ? draft.labels : [],
    candidateWorkspaceIds: binding.candidateWorkspaceIds,
    deviceId: agentConnection?.deviceId || conversation.deviceId || null,
    deviceName: agentConnection?.deviceName || conversation.deviceName || null,
    runStatus: agentClients.has(agentId) ? "accepted" : "queued",
    approvalState: "not_required",
  });

  if (binding.workspaceId && conversation.workspaceId !== binding.workspaceId) {
    await store.updateConversation(conversation.id, {
      workspaceId: binding.workspaceId,
    });
  }

  return task;
}

async function submitUserTaskToEmployee({
  agentId,
  text,
  requestedConversationId = null,
  clientMessageId = null,
  title = null,
  workspaceId = null,
  requestedBy = "human",
  taskDraft = null,
}) {
  const existing = store.findConversationMessageByClientMessageId(clientMessageId);
  if (existing) {
    return {
      conversation: existing.conversation,
      message: existing.message,
      task: store.findTaskBySourceMessageId(existing.message.id),
    };
  }

  const agentConnection = agentClients.get(agentId);
  let conversation = requestedConversationId ? store.getConversation(requestedConversationId) : null;

  if (requestedConversationId && !conversation) {
    throw new Error("要发送消息的会话不存在");
  }

  if (!conversation) {
    const workspace = workspaceId ? store.getWorkspace(workspaceId) : null;
    conversation = await store.createConversation(agentId, {
      title: normalizeText(title) || buildConversationTitle(text, "New chat"),
      deviceId: agentConnection?.deviceId || workspace?.deviceId || null,
      deviceName: agentConnection?.deviceName || workspace?.deviceName || null,
      workspaceId: workspaceId || null,
      codexWorkdir: workspace?.path || null,
    });
  } else if (
    conversation.messages.length === 0 &&
    !conversation.codexSessionId &&
    (!conversation.title || conversation.title === "New chat")
  ) {
    conversation = await store.updateConversation(conversation.id, {
      title: normalizeText(title) || buildConversationTitle(text, "New chat"),
    });
  }

  if (workspaceId && conversation.workspaceId !== workspaceId) {
    const workspace = store.getWorkspace(workspaceId);
    conversation = await store.updateConversation(conversation.id, {
      workspaceId,
      codexWorkdir: workspace?.path || conversation.codexWorkdir || null,
    });
  } else if (agentConnection && (!conversation.deviceId || !conversation.deviceName)) {
    conversation = await store.updateConversation(conversation.id, {
      deviceId: agentConnection.deviceId,
      deviceName: agentConnection.deviceName,
    });
  }

  const message = {
    id: randomUUID(),
    clientMessageId: normalizeText(clientMessageId) || null,
    role: "user",
    text,
    agentId,
    status: agentClients.has(agentId) ? "sent" : "queued",
    createdAt: new Date().toISOString(),
  };

  await store.addMessage(conversation.id, message);
  const task = await createTaskForUserMessage({
    conversation,
    message,
    agentId,
    agentConnection,
    taskDraft,
  });
  if (task && normalizeText(requestedBy) && requestedBy !== "human" && !taskDraft) {
    await store.updateTask(task.id, { requestedBy: normalizeText(requestedBy) });
  }

  if (agentClients.has(agentId)) {
    await deliverMessageToAgent(agentId, conversation.id, message, task);
  }

  return {
    conversation,
    message,
    task,
  };
}

function buildTaskAssignmentPayload(task, conversation) {
  const workspace = task.workspaceId ? store.getWorkspace(task.workspaceId) : null;

  return {
    type: "task.assigned",
    task: {
      id: task.id,
      title: task.title,
      goal: task.goal,
      managerSummary: task.managerSummary || null,
      successSignal: task.successSignal || null,
      requestedBy: task.requestedBy || "human",
      workspace: workspace
        ? {
            id: workspace.id,
            name: workspace.name,
            path: workspace.path,
            kind: workspace.kind,
          }
        : null,
      constraints: {
        sandbox: "workspace-default",
        humanApprovalRequiredFor: [],
      },
      approvalPolicy: {
        mode: "explicit-risk-only",
      },
      directConversationId: conversation.id,
      sourceMessageId: task.sourceMessageId,
      candidateWorkspaceIds: task.candidateWorkspaceIds || [],
    },
    conversationId: conversation.id,
    message: conversation.messages.find((item) => item.id === task.sourceMessageId) || null,
    conversation,
  };
}

async function deliverMessageToAgent(agentId, conversationId, message, task = null) {
  const agentConnection = agentClients.get(agentId);
  if (!agentConnection) {
    return false;
  }

  await store.updateMessage(conversationId, message.id, {
    status: "sent",
    deliveredAt: new Date().toISOString(),
  });
  if (task) {
    await store.updateTask(task.id, {
      status: "assigned",
      runStatus: "accepted",
      latestSummary: "任务已送达数字员工，等待开始执行。",
    });
  }

  const conversation = store.getConversation(conversationId);
  sendJson(
    agentConnection.socket,
    task
      ? buildTaskAssignmentPayload(task, conversation)
      : {
          type: "deliver_user_message",
          agentId,
          conversationId,
          message,
          conversation,
        }
  );

  return true;
}

function updateAgentConnection(agentId, patch) {
  const current = agentClients.get(agentId);
  if (!current) {
    return null;
  }

  const next = {
    ...current,
    ...patch,
    lastSeenAt: new Date().toISOString(),
  };

  agentClients.set(agentId, next);
  return next;
}

async function flushQueuedMessages(agentId) {
  const queued = store.listQueuedMessages(agentId);
  for (const item of queued) {
    const task = store.findTaskBySourceMessageId(item.message.id);
    if (task) {
      await store.updateTask(task.id, {
        status: "assigned",
        runStatus: "accepted",
        latestSummary: "数字员工已重新连线，任务重新分派。",
      });
    }
    await deliverMessageToAgent(agentId, item.conversationId, item.message, task);
  }
  broadcastSnapshot();
}

function resolveEmployeeMatches(employeeRef, snapshot) {
  const reference = normalizeText(employeeRef).toLowerCase();
  if (!reference) {
    return [];
  }

  const exact = snapshot.agents.filter((agent) => {
    const id = agent.id.toLowerCase();
    const name = agent.name.toLowerCase();
    return id === reference || name === reference;
  });
  if (exact.length > 0) {
    return exact;
  }

  return snapshot.agents.filter((agent) => {
    const haystacks = [
      agent.id,
      agent.name,
      agent.deviceName,
      agent.deviceId,
      `${agent.deviceName} ${agent.name}`,
    ]
      .filter(Boolean)
      .map((value) => value.toLowerCase());
    return haystacks.some((value) => value.includes(reference));
  });
}

function resolveWorkspaceMatches(workspaceRef, snapshot, employeeId = null) {
  const reference = normalizeText(workspaceRef).toLowerCase();
  if (!reference) {
    return [];
  }

  return (snapshot.workspaces || []).filter((workspace) => {
    if (employeeId && workspace.employeeId !== employeeId) {
      return false;
    }

    const haystacks = [
      workspace.id,
      workspace.name,
      workspace.path,
      workspace.deviceName,
      workspace.employeeName,
    ]
      .filter(Boolean)
      .map((value) => String(value).toLowerCase());
    return haystacks.some((value) => value.includes(reference));
  });
}

function resolveWorkspaceSelection(snapshot, employee, workspaceRef = null) {
  const employeeWorkspaces = (snapshot.workspaces || []).filter(
    (workspace) => workspace.employeeId === employee.id
  );

  if (normalizeText(workspaceRef)) {
    const matches = resolveWorkspaceMatches(workspaceRef, snapshot, employee.id);
    if (matches.length === 0) {
      if (employeeWorkspaces.length === 1) {
        return {
          ok: true,
          workspace: employeeWorkspaces[0],
          autoSelected: true,
          assumedFromSingleWorkspace: true,
        };
      }

      return {
        ok: false,
        error: "WORKSPACE_NOT_FOUND",
        message: "没有找到该员工名下匹配的工作区。",
      };
    }

    if (matches.length > 1) {
      return {
        ok: false,
        error: "WORKSPACE_AMBIGUOUS",
        message: "这个工作区描述匹配到多个目标，请更具体一点。",
        matches: matches.map((workspace) => ({
          id: workspace.id,
          name: workspace.name,
          path: workspace.path,
        })),
      };
    }

    return {
      ok: true,
      workspace: matches[0],
      autoSelected: false,
      assumedFromSingleWorkspace: false,
    };
  }

  if (employeeWorkspaces.length === 1) {
    return {
      ok: true,
      workspace: employeeWorkspaces[0],
      autoSelected: true,
      assumedFromSingleWorkspace: false,
    };
  }

  return {
    ok: true,
    workspace: null,
    autoSelected: false,
    assumedFromSingleWorkspace: false,
  };
}

function extractDelegationGoal(text, agent) {
  let goal = normalizeText(text);
  if (!goal || !agent) {
    return "";
  }

  const escapedAgentTokens = [
    agent.name,
    agent.id,
    agent.deviceName ? `${agent.deviceName}上的${agent.name}` : null,
    agent.deviceName ? `${agent.deviceName} ${agent.name}` : null,
  ]
    .filter(Boolean)
    .map((value) => escapeRegex(value));

  if (escapedAgentTokens.length > 0) {
    const agentPattern = escapedAgentTokens.join("|");
    const directivePattern = new RegExp(
      `^(?:请|帮我)?(?:让|安排|交给|派给|交由)\\s*(?:${agentPattern})\\s*(?:去|来|负责|帮我)?\\s*`,
      "i"
    );
    goal = goal.replace(directivePattern, "");
  }

  goal = goal.replace(/^(?:在|到|去|用)\s*[^，。；;\n]+?\s*(?:工作区|workspace|仓库|repo|目录)\s*/i, "");

  goal = goal
    .replace(/^(处理|推进|修复|修一下|修下|看一下|看下|整理|负责|跟进)\s*/i, "")
    .replace(/[。！？!?\s]+$/g, "")
    .trim();

  return goal;
}

function extractWorkspaceReference(text) {
  const normalized = normalizeText(text);
  if (!normalized) {
    return null;
  }

  const patterns = [
    /(?:工作区|workspace|仓库|repo|目录)\s*[:：]?\s*([^，。；;\n]+)/i,
    /(?:在|到|去|用)\s*([^，。；;\n]+?)\s*(?:工作区|workspace|仓库|repo|目录)/i,
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    const value = normalizeText(match?.[1]);
    if (value) {
      return value;
    }
  }

  return null;
}

function parseDelegationIntent(text, snapshot) {
  if (!/(让|安排|交给|派给|交由)/.test(text)) {
    return null;
  }

  const employee = findMentionedAgent(snapshot, text);
  if (!employee) {
    return {
      ok: false,
      error: "EMPLOYEE_NOT_FOUND",
      message: "我理解你是在分派任务，但还没识别出目标员工。",
    };
  }

  const goal = extractDelegationGoal(text, employee);
  if (!goal) {
    return {
      ok: false,
      error: "GOAL_MISSING",
      message: `我知道你想把任务交给 ${employee.name}，但还没识别出具体目标。`,
    };
  }

  const workspaceRef = extractWorkspaceReference(text);
  const workspaceSelection = resolveWorkspaceSelection(snapshot, employee, workspaceRef);
  if (!workspaceSelection.ok) {
    return workspaceSelection;
  }

  return {
    ok: true,
    employee,
    goal,
    workspace: workspaceSelection.workspace || null,
    autoSelectedWorkspace: workspaceSelection.autoSelected,
    assumedFromSingleWorkspace: workspaceSelection.assumedFromSingleWorkspace,
  };
}


function buildAttentionItemAction(item, snapshot) {
  if (!item) {
    return null;
  }

  if (item.taskId) {
    const task =
      (snapshot.tasks || []).find((entry) => entry.id === item.taskId) ||
      (snapshot.tasks || []).find((entry) => entry.taskId === item.taskId) ||
      null;
    if (task) {
      return buildTaskDetailAction(task, {
        label: "查看需要关注的任务",
        description: "先看这条任务的细节，再决定要不要切到直连或重新安排。",
      });
    }
  }

  if (item.agentId) {
    const agent = (snapshot.agents || []).find((entry) => entry.id === item.agentId) || null;
    if (agent) {
      const conversation = store.listConversationsByAgent(agent.id).sort(compareByRecency)[0] || null;
      return buildEmployeeDetailAction(agent, conversation, {
        label: `查看 ${agent.name} 的详情`,
        description: "查看这位员工当前的状态、任务和最近对话。",
      });
    }
  }

  return null;
}

function formatAttentionReply(snapshot, items) {
  if (!Array.isArray(items) || items.length === 0) {
    return "当前没有需要你立刻介入的异常。现在整体比较平稳，你可以继续直接下达新目标。";
  }

  return [
    "当前最值得你优先关注的是：",
    ...items.slice(0, 4).map((item, index) => `${index + 1}. ${item.title}：${item.body}`),
  ].join("\n");
}

function isManagerIdentityQuestion(text) {
  return /(你是谁|你是做什么的|你是干嘛的|介绍一下你自己|经理是谁|你是什么)/.test(text);
}

function isManagerCapabilityQuestion(text) {
  return /(你能做啥|你能做什么|你会做啥|你会什么|能帮我做啥|能帮我做什么|怎么用你|你可以帮我什么)/.test(
    text
  );
}

function isEmployeeDetailQuestion(text) {
  return /(具体信息|详细信息|详细情况|具体情况|详情|细节|介绍|资料|信息是啥|信息是什么)/.test(
    text
  );
}

function selectEmployeesForDetail(snapshot, text, mentionedAgent) {
  if (mentionedAgent) {
    return [mentionedAgent];
  }

  if (/(在线员工|在线的员工|谁在线|在线的)/.test(text)) {
    return snapshot.agents.filter((agent) => agent.online);
  }

  if (/(离线员工|离线的员工|谁离线|离线的)/.test(text)) {
    return snapshot.agents.filter((agent) => !agent.online);
  }

  return snapshot.agents;
}

function formatEmployeeDetailReply(snapshot, agents) {
  if (!Array.isArray(agents) || agents.length === 0) {
    return "当前没有匹配到需要展开详情的员工。";
  }

  return agents
    .slice(0, 6)
    .map((agent) => {
      const employee = summarizeEmployee(agent, snapshot);
      const workspaces = (snapshot.workspaces || [])
        .filter((workspace) => workspace.employeeId === agent.id)
        .slice(0, 3)
        .map((workspace) => workspace.name)
        .filter(Boolean);

      const workspaceText = workspaces.length > 0 ? workspaces.join("、") : "未登记工作区";
      const summaryText = agent.lastSummary || employee.currentTaskSummary || "最近还没有汇报。";
      const taskText = employee.currentTaskTitle
        ? `当前任务是“${employee.currentTaskTitle}”，状态 ${employee.currentTaskStatus}。`
        : `当前${employee.online ? "在线但空闲" : "离线"}。`;

      return `${employee.name}：设备 ${employee.deviceName}，运行时 ${employee.runtime}，${
        employee.online ? "在线" : "离线"
      }。${taskText} 工作区：${workspaceText}。最近汇报：${summaryText}`;
    })
    .join("\n");
}

function buildManagerIdentityReply(snapshot) {
  const onlineCount = snapshot.agents.filter((agent) => agent.online).length;
  const totalCount = snapshot.agents.length;
  const workspaceCount = Array.isArray(snapshot.workspaces) ? snapshot.workspaces.length : 0;
  const taskCount = Array.isArray(snapshot.tasks) ? snapshot.tasks.length : 0;

  return [
    "我是 AgentHub 的 AI经理，负责把你的目标翻译成员工任务、汇总执行进度，并在必要时把你切到某位员工的直连。",
    `当前我接管的是这个工作台：${onlineCount}/${totalCount} 位员工在线，${taskCount} 条任务，${workspaceCount} 个工作区。`,
    MANAGER_PROVIDER === "local"
      ? "我现在运行在本地摘要模式，更擅长明确指令，比如盘点员工、查看任务、追某位员工进度、切到直连和处理审批。"
      : `当前经理模型：${MANAGER_PROVIDER} · ${MANAGER_MODEL}。`,
  ].join("\n\n");
}

function buildManagerCapabilityReply(snapshot, prefix = "我现在最适合帮你做这些事：") {
  return [
    prefix,
    "1. 盘点员工：现在有哪些员工在线、分别在什么设备上。",
    "2. 看执行情况：谁在做什么、谁卡住了、最近有什么进度。",
    "3. 分派任务：把某个目标交给指定员工，并尽量自动绑定工作区。",
    "4. 进入直连：当你要亲自指导某位员工时，我可以直接给你跳转入口。",
    "5. 处理审批：帮你找出待确认事项，并在你同意或拒绝后回推给员工。",
    "6. 监督异常：告诉你谁卡住了、谁离线但任务没结束、哪些任务久未更新。",
    "7. 催办纠偏：直接替你给某位员工发跟进消息、补充要求或催他汇报。",
    "8. 诊断接入：帮你判断某位员工是没接上、没工作区、假在线，还是当前任务异常。",
    "9. 解释平台知识：比如新 Agent 怎么接入、平台怎么工作、经理职责怎么扩。",
    snapshot.agents.length > 0
      ? `你现在就可以这样问我：现在我的员工有哪些 / 帮我看看 ${snapshot.agents[0].name} 在做什么 / 帮我切到和 ${snapshot.agents[0].name} 的对话`
      : "等员工接入后，你就可以直接问我他们的状态和任务进展。",
  ].join("\n");
}

function isOnboardingGuideQuestion(text) {
  return /(具体.*(接入|接进|连上|上线)|怎么.*(接入|接进|连上|上线)|如何.*(接入|接进|连上|上线)|接入.*(步骤|命令|流程)|onboard|新设备.*(接入|上线)|新员工.*(接入|上线)|codex.*(接入|接进|连上|上线))/i.test(
    text
  );
}

function isManagerKnowledgeQuestion(text) {
  return /(接入|怎么接|如何接|onboard|注册|新增.*(agent|员工|设备)|别的agent|其他agent|怎么连到平台|平台怎么工作|工作原理|架构|职责|边界|知识库|扩职责|扩知识|扩能力|运行机制|接入方式)/i.test(
    text
  );
}

function isAttentionQuestion(text) {
  return /(最该关注|优先关注|谁卡住了|谁停住了|哪里有风险|有什么异常|需要我介入|待我确认|谁需要跟进|谁最危险|阻塞任务|长时间无更新|谁离线了)/.test(
    text
  );
}

function shouldPreferDeterministicManagerFlow(text, snapshot = buildSnapshot()) {
  const mentionedAgent = findMentionedAgent(snapshot, text);
  const directChatIntent = analyzeDirectChatIntent(text, snapshot);

  if (
    isManagerIdentityQuestion(text) ||
    isManagerCapabilityQuestion(text) ||
    isOnboardingGuideQuestion(text) ||
    isManagerKnowledgeQuestion(text) ||
    isAttentionQuestion(text)
  ) {
    return true;
  }

  if (
    directChatIntent ||
    /(审批|授权|批准|风险)/.test(text) ||
    (mentionedAgent && isEmployeeDiagnosisQuestion(text)) ||
    (mentionedAgent && isEmployeeDetailQuestion(text)) ||
    (mentionedAgent && /(进度|在做|干啥|做啥|状态)/.test(text)) ||
    (mentionedAgent &&
      /(切到|直连|对话|连接|进入|打开|连到|切换到|带我去|跳到)/.test(text))
  ) {
    return true;
  }

  if (mentionedAgent && /(催一下|跟进一下|提醒一下|告诉|通知|让.*汇报|继续推进|先停一下|暂停一下|补充要求)/.test(text)) {
    return true;
  }

  if (/(任务|进度|状态|做到哪|完成没|卡住)/.test(text)) {
    return true;
  }

  return false;
}

function isEmployeeDiagnosisQuestion(text) {
  return /(为什么.*(没接上|接不上|离线|不在线|没工作区|没有工作区|异常|有问题)|接入.*正常|健康.*怎样|是不是假在线|是不是停住了|诊断一下)/.test(
    text
  );
}

function buildFollowUpMessage(text, agentName = "") {
  const normalized = normalizeText(text);
  if (!normalized) {
    return "请汇报你当前的进度、阻塞点和下一步计划。";
  }

  if (/(催一下|跟进一下|提醒一下)/.test(normalized)) {
    return "请尽快汇报你当前的进度、阻塞点和下一步计划。";
  }

  if (/(继续推进|继续做|接着做)/.test(normalized)) {
    return "请继续推进当前任务，并在有关键进展或阻塞时立即汇报。";
  }

  if (/(先停一下|暂停一下|先别做|停一下)/.test(normalized)) {
    return "请先暂停当前推进，先汇报你已经完成了什么、当前停在哪一步。";
  }

  if (agentName) {
    const stripped = normalized
      .replace(new RegExp(escapeRegex(agentName), "gi"), "")
      .replace(/^(帮我|麻烦|请|让|通知|告诉|提醒|催|催一下|跟进|跟进一下)\s*/i, "")
      .trim();
    if (stripped) {
      return stripped;
    }
  }

  return normalized;
}

function getOnboardingGuideTool(args = {}) {
  const runtime = normalizeText(args.runtime).toLowerCase() || "codex";
  const replyText = buildOnboardingGuideReply(runtime);

  return {
    output: {
      ok: true,
      runtime,
      hubOrigin: getPreferredHubOrigin(),
      replyText,
    },
    clientAction: null,
  };
}

function searchManagerKnowledgeTool({ query }) {
  const resolvedQuery = normalizeText(query);
  const matches = searchManagerKnowledge(MANAGER_KNOWLEDGE_BASE, resolvedQuery, 3);

  return {
    output: {
      ok: matches.length > 0,
      query: resolvedQuery,
      matches: matches.map((article) => ({
        id: article.id,
        title: article.title,
        summary: article.summary,
        excerpt: article.excerpt,
        keywords: article.keywords,
        score: article.score,
      })),
    },
    clientAction: null,
  };
}

function resolveApprovalMatches(snapshot, options = {}) {
  const approvalRef = normalizeText(options.approvalRef).toLowerCase();
  const employeeRef = normalizeText(options.employeeRef).toLowerCase();
  const taskRef = normalizeText(options.taskRef).toLowerCase();
  const pendingApprovals = (snapshot.approvals || []).filter(
    (approval) => approval.status === "pending"
  );

  if (pendingApprovals.length === 0) {
    return [];
  }

  if (!approvalRef && !employeeRef && !taskRef) {
    return pendingApprovals.slice(0, 1);
  }

  return pendingApprovals.filter((approval) => {
    const employee = snapshot.agents.find((agent) => agent.id === approval.requestedByEmployeeId);
    const task = snapshot.tasks.find(
      (item) => item.taskId === approval.taskId || item.id === approval.taskId
    );
    const haystacks = [
      approval.id,
      approval.reason,
      approval.requestedAction,
      approval.scope,
      employee?.id,
      employee?.name,
      task?.id,
      task?.taskId,
      task?.title,
    ]
      .filter(Boolean)
      .map((value) => String(value).toLowerCase());

    if (approvalRef && haystacks.some((value) => value.includes(approvalRef))) {
      return true;
    }

    if (employeeRef) {
      const employeeMatched = [employee?.id, employee?.name]
        .filter(Boolean)
        .map((value) => String(value).toLowerCase())
        .some((value) => value.includes(employeeRef));
      if (employeeMatched) {
        return true;
      }
    }

    if (taskRef) {
      const taskMatched = [task?.id, task?.taskId, task?.title]
        .filter(Boolean)
        .map((value) => String(value).toLowerCase())
        .some((value) => value.includes(taskRef));
      if (taskMatched) {
        return true;
      }
    }

    return false;
  });
}

async function resolveApprovalDecision({
  approvalRef,
  employeeRef,
  taskRef,
  decision,
  note = "",
  decidedBy = "manager",
}) {
  const snapshot = buildSnapshot();
  const matches = resolveApprovalMatches(snapshot, {
    approvalRef,
    employeeRef,
    taskRef,
  });

  if (matches.length === 0) {
    return {
      ok: false,
      error: "APPROVAL_NOT_FOUND",
      message: "没有找到匹配的待审批项。",
    };
  }

  if (matches.length > 1) {
    return {
      ok: false,
      error: "APPROVAL_AMBIGUOUS",
      message: "找到了多个待审批项，需要你更具体一点。",
      matches: matches.map((approval) => ({
        id: approval.id,
        taskId: approval.taskId,
        requestedByEmployeeId: approval.requestedByEmployeeId,
        reason: approval.reason,
      })),
    };
  }

  const approval = matches[0];
  const normalizedDecision = ["approved", "rejected"].includes(normalizeText(decision).toLowerCase())
    ? normalizeText(decision).toLowerCase()
    : "approved";
  const resolutionTimestamp = new Date().toISOString();

  await store.updateApproval(approval.id, {
    status: normalizedDecision,
    grantedBy: normalizedDecision === "approved" ? decidedBy : null,
    grantedAt: normalizedDecision === "approved" ? resolutionTimestamp : null,
    rejectedAt: normalizedDecision === "rejected" ? resolutionTimestamp : null,
    resolutionNote: normalizeText(note) || null,
  });

  const task = approval.taskId ? store.getTask(approval.taskId) : null;
  if (task) {
    await store.updateTask(task.id, {
      status: normalizedDecision === "approved" ? "assigned" : "blocked",
      runStatus: normalizedDecision === "approved" ? "accepted" : "blocked",
      approvalState: normalizedDecision,
      blockedReason: normalizedDecision === "approved" ? null : approval.reason,
      latestSummary:
        normalizedDecision === "approved"
          ? `审批已通过，等待 ${approval.requestedByEmployeeId || "数字员工"} 继续执行。`
          : `审批被拒绝：${normalizeText(note) || approval.reason}`,
    });

    const employeeSocket = agentClients.get(task.ownerEmployeeId)?.socket || null;
    if (employeeSocket) {
      sendJson(employeeSocket, {
        type: "approval_resolved",
        approvalId: approval.id,
        taskId: task.id,
        runId: approval.runId || task.runId || `run-${task.id}`,
        decision: normalizedDecision,
        note: normalizeText(note) || null,
      });
    }
  }

  if (task?.ownerEmployeeId) {
    await store.updateEmployee(task.ownerEmployeeId, {
      status: normalizedDecision === "approved" ? "busy" : "blocked",
      currentTaskId: task.id,
      currentRunId: approval.runId || task.runId || `run-${task.id}`,
      lastSummary:
        normalizedDecision === "approved"
          ? `审批已通过：${task.title}`
          : `审批被拒绝：${normalizeText(note) || approval.reason}`,
      lastSeenAt: resolutionTimestamp,
    });
  }

  return {
    ok: true,
    approvalId: approval.id,
    decision: normalizedDecision,
    taskId: task?.id || approval.taskId || null,
    message:
      normalizedDecision === "approved"
        ? "我已经批准这项审批，相关员工可以继续推进。"
        : "我已经拒绝这项审批，并把结果反馈给对应员工。",
  };
}

function normalizeStatusReference(value) {
  const normalized = normalizeText(value).toLowerCase();
  return normalized.replace(/\s+/g, "_");
}

function resolveTaskMatches(snapshot, taskRef, employeeId = null) {
  const reference = normalizeText(taskRef).toLowerCase();
  if (!reference) {
    return [];
  }

  const candidates = (snapshot.tasks || []).filter(
    (task) => !employeeId || task.agentId === employeeId
  );

  const exact = candidates.filter((task) => {
    const haystacks = [task.id, task.taskId, task.title]
      .filter(Boolean)
      .map((value) => String(value).toLowerCase());
    return haystacks.includes(reference);
  });
  if (exact.length > 0) {
    return exact;
  }

  return candidates.filter((task) => {
    const haystacks = [
      task.id,
      task.taskId,
      task.title,
      task.lastUserText,
      task.progressSummary,
      task.workspaceName,
      task.agentName,
      task.deviceName,
      task.managerSummary,
    ]
      .filter(Boolean)
      .map((value) => String(value).toLowerCase());
    return haystacks.some((value) => value.includes(reference));
  });
}

function filterTasksForManager(snapshot, { employeeRef = "", status = "" } = {}) {
  let tasks = [...(snapshot.tasks || [])];

  if (normalizeText(employeeRef)) {
    const matches = resolveEmployeeMatches(employeeRef, snapshot);
    if (matches.length === 0) {
      return {
        ok: false,
        error: "EMPLOYEE_NOT_FOUND",
        message: "没有找到这位数字员工。",
      };
    }

    if (matches.length > 1) {
      return {
        ok: false,
        error: "EMPLOYEE_AMBIGUOUS",
        message: "员工名称匹配到多位，请更具体一点。",
        matches: matches.map((agent) => ({
          id: agent.id,
          name: agent.name,
          deviceName: agent.deviceName,
        })),
      };
    }

    tasks = tasks.filter((task) => task.agentId === matches[0].id);
  }

  if (normalizeText(status)) {
    const statusRef = normalizeStatusReference(status);
    tasks = tasks.filter((task) => {
      const candidates = [
        task.status,
        task.statusLabel,
        task.runStatus,
        task.approvalState,
      ]
        .filter(Boolean)
        .map((value) => normalizeStatusReference(value));
      return candidates.some((value) => value.includes(statusRef));
    });
  }

  return {
    ok: true,
    tasks,
  };
}

async function listEmployeesTool() {
  const snapshot = buildSnapshot();
  return {
    output: {
      ok: true,
      employees: snapshot.agents.map((agent) => summarizeEmployee(agent, snapshot)),
      summary: snapshot.manager.summary,
    },
    clientAction: null,
  };
}

async function listAttentionItemsTool() {
  const snapshot = buildSnapshot();
  const items = buildAttentionItems(snapshot, {
    staleTaskMinutes: STALE_TASK_MINUTES,
  });

  return {
    output: {
      ok: true,
      items,
      summary: snapshot.manager.summary,
    },
    clientAction: buildAttentionItemAction(items[0] || null, snapshot),
  };
}

async function listTasksTool(args = {}) {
  const snapshot = buildSnapshot();
  const filtered = filterTasksForManager(snapshot, {
    employeeRef: args.employee_ref,
    status: args.status,
  });
  if (!filtered.ok) {
    return {
      output: filtered,
      clientAction: null,
    };
  }

  return {
    output: {
      ok: true,
      tasks: filtered.tasks.slice(0, 12),
      summary: snapshot.manager.summary,
    },
    clientAction: null,
  };
}

async function getTaskStatusTool(args = {}) {
  const snapshot = buildSnapshot();
  const matches = resolveTaskMatches(snapshot, args.task_ref);

  if (matches.length === 0) {
    return {
      output: {
        ok: false,
        error: "TASK_NOT_FOUND",
        message: "没有找到对应的任务。",
      },
      clientAction: null,
    };
  }

  if (matches.length > 1) {
    return {
      output: {
        ok: false,
        error: "TASK_AMBIGUOUS",
        message: "找到了多条可能的任务，需要更具体的任务标题或 ID。",
        matches: matches.slice(0, 6).map((task) => ({
          id: task.id,
          title: task.title,
          agentName: task.agentName,
          deviceName: task.deviceName,
        })),
      },
      clientAction: null,
    };
  }

  const task = matches[0];
  return {
    output: {
      ok: true,
      task,
    },
    clientAction: buildTaskDetailAction(task, {
      description: "查看这条任务的完整状态、工作区和相关会话，再决定是否继续追问或切到直连。",
      label: "查看任务详情",
    }),
  };
}

async function listWorkspacesTool(args = {}) {
  const snapshot = buildSnapshot();
  let workspaces = [...(snapshot.workspaces || [])];

  if (normalizeText(args.employee_ref)) {
    const matches = resolveEmployeeMatches(args.employee_ref, snapshot);
    if (matches.length === 0) {
      return {
        output: {
          ok: false,
          error: "EMPLOYEE_NOT_FOUND",
          message: "没有找到这位数字员工。",
        },
        clientAction: null,
      };
    }

    if (matches.length > 1) {
      return {
        output: {
          ok: false,
          error: "EMPLOYEE_AMBIGUOUS",
          message: "员工名称匹配到多位，请更具体一点。",
          matches: matches.map((agent) => ({
            id: agent.id,
            name: agent.name,
            deviceName: agent.deviceName,
          })),
        },
        clientAction: null,
      };
    }

    workspaces = workspaces.filter((workspace) => workspace.employeeId === matches[0].id);
  }

  return {
    output: {
      ok: true,
      workspaces,
      summary: snapshot.manager.summary,
    },
    clientAction: null,
  };
}

async function resolveWorkspaceForEmployeeTool(args = {}) {
  const snapshot = buildSnapshot();
  const matches = resolveEmployeeMatches(args.employee_ref, snapshot);
  if (matches.length === 0) {
    return {
      output: {
        ok: false,
        error: "EMPLOYEE_NOT_FOUND",
        message: "没有找到这位数字员工。",
      },
      clientAction: null,
    };
  }

  if (matches.length > 1) {
    return {
      output: {
        ok: false,
        error: "EMPLOYEE_AMBIGUOUS",
        message: "员工名称匹配到多位，请更具体一点。",
        matches: matches.map((agent) => ({
          id: agent.id,
          name: agent.name,
          deviceName: agent.deviceName,
        })),
      },
      clientAction: null,
    };
  }

  const employee = matches[0];
  const workspaceSelection = resolveWorkspaceSelection(
    snapshot,
    employee,
    args.workspace_ref
  );

  return {
    output: {
      ok: workspaceSelection.ok,
      employee: summarizeEmployee(employee, snapshot),
      workspace: workspaceSelection.workspace || null,
      autoSelected: Boolean(workspaceSelection.autoSelected),
      assumedFromSingleWorkspace: Boolean(workspaceSelection.assumedFromSingleWorkspace),
      matches: workspaceSelection.matches || [],
      error: workspaceSelection.error || null,
      message:
        workspaceSelection.message ||
        (workspaceSelection.workspace
          ? `已定位到 ${employee.name} 的工作区 ${workspaceSelection.workspace.name}。`
          : "当前没有定位到唯一工作区。"),
    },
    clientAction: buildEmployeeDetailAction(employee, null, {
      description: "查看这位员工的详情和最近任务，再决定是否直接下达新任务。",
      label: `查看 ${employee.name} 的详情`,
    }),
  };
}

async function switchToEmployeeChat(employeeRef) {
  const snapshot = buildSnapshot();
  const matches = resolveEmployeeMatches(employeeRef, snapshot);
  if (matches.length === 0) {
    return {
      output: {
        ok: false,
        error: "EMPLOYEE_NOT_FOUND",
        message: "没有找到对应的数字员工。",
        suggestions: snapshot.agents.map((agent) => agent.name),
      },
      clientAction: null,
    };
  }

  if (matches.length > 1) {
    return {
      output: {
        ok: false,
        error: "EMPLOYEE_AMBIGUOUS",
        message: "找到多位可能的员工，需要你确认。",
        matches: matches.map((agent) => ({
          id: agent.id,
          name: agent.name,
          deviceName: agent.deviceName,
        })),
      },
      clientAction: null,
    };
  }

  const agent = matches[0];
  let conversation = store
    .listConversationsByAgent(agent.id)
    .sort(compareByRecency)[0];

  if (!conversation) {
    conversation = await store.createConversation(agent.id, {
      title: "New chat",
      deviceId: agent.deviceId,
      deviceName: agent.deviceName,
    });
    broadcastSnapshot();
  }

  const currentTask = buildTaskDescriptor(conversation, agent);
  return {
    output: {
      ok: true,
      agent: summarizeEmployee(agent, buildSnapshot()),
      conversationId: conversation.id,
      currentTask,
      message: `已切到和 ${agent.name} 的直连对话。`,
    },
    clientAction: buildEmployeeDetailAction(agent, conversation, {
      label: `进入与 ${agent.name} 的直连`,
      description: "跳到该员工的专属会话，继续直接指导他。",
    }),
  };
}

function buildEmployeeDetailAction(agent, conversation = null, overrides = {}) {
  return {
    type: "switch_direct",
    agentId: agent.id,
    agentName: agent.name,
    deviceName: agent.deviceName,
    conversationId: conversation?.id || null,
    conversationTitle: conversation?.title || "New chat",
    title: overrides.title || `${agent.name} · ${agent.deviceName}`,
    description:
      overrides.description ||
      "进入该员工的直连页，查看当前任务、上下文和最近对话。",
    label: overrides.label || `查看 ${agent.name} 的详情`,
  };
}

function buildTaskDetailAction(task, overrides = {}) {
  if (!task?.id) {
    return null;
  }

  return {
    type: "open_task_detail",
    taskId: task.id,
    conversationId: task.conversationId || null,
    agentId: task.agentId || null,
    agentName: task.agentName || null,
    deviceName: task.deviceName || null,
    title: overrides.title || `任务详情 · ${task.title || "未命名任务"}`,
    description:
      overrides.description ||
      "查看这条任务的状态、工作区、最近进展和相关会话，再决定是否要直连员工。",
    label: overrides.label || "查看任务详情",
  };
}

function buildTaskDetailActionFromStoredTask(task, snapshot = buildSnapshot(), overrides = {}) {
  if (!task?.id) {
    return null;
  }

  const agentMap = new Map((snapshot.agents || []).map((item) => [item.id, item]));
  const workspaceMap = new Map((snapshot.workspaces || []).map((item) => [item.id, item]));
  const conversationMap = new Map(
    (snapshot.conversations || []).map((item) => [item.id, item])
  );

  return buildTaskDetailAction(
    buildPersistedTaskDescriptor(task, agentMap, workspaceMap, conversationMap),
    overrides
  );
}

function buildApprovalTaskAction(snapshot, approval, overrides = {}) {
  if (!approval?.taskId) {
    return null;
  }

  const task =
    (snapshot.tasks || []).find((item) => item.id === approval.taskId) ||
    (snapshot.tasks || []).find((item) => item.taskId === approval.taskId) ||
    null;

  return buildTaskDetailAction(task, overrides);
}

async function listApprovalsTool() {
  const snapshot = buildSnapshot();
  return {
    output: {
      ok: true,
      approvals: snapshot.approvals || [],
      summary: snapshot.manager.summary,
    },
    clientAction: null,
  };
}

async function resolveApprovalTool(args = {}) {
  return {
    output: await resolveApprovalDecision({
      approvalRef: args.approval_ref,
      employeeRef: args.employee_ref,
      taskRef: args.task_ref,
      decision: args.decision,
      note: args.note,
      decidedBy: "manager",
    }),
    clientAction: null,
  };
}

async function assignTaskToEmployeeTool(args = {}) {
  const snapshot = buildSnapshot();
  const matches = resolveEmployeeMatches(args.employee_ref, snapshot);
  if (matches.length === 0) {
    return {
      output: {
        ok: false,
        error: "EMPLOYEE_NOT_FOUND",
        message: "没有找到要分派任务的数字员工。",
      },
      clientAction: null,
    };
  }

  if (matches.length > 1) {
    return {
      output: {
        ok: false,
        error: "EMPLOYEE_AMBIGUOUS",
        message: "找到多位可能的数字员工，需要更具体的员工名字。",
        matches: matches.map((agent) => ({
          id: agent.id,
          name: agent.name,
          deviceName: agent.deviceName,
        })),
      },
      clientAction: null,
    };
  }

  const employee = matches[0];
  const workspaceSelection = resolveWorkspaceSelection(snapshot, employee, args.workspace_ref);
  if (!workspaceSelection.ok) {
    return {
      output: workspaceSelection,
      clientAction: null,
    };
  }

  const taskDraft = buildManagerTaskDraft({
    goal: args.goal,
    employee,
    workspace: workspaceSelection.workspace || null,
    autoSelectedWorkspace: workspaceSelection.autoSelected,
    assumedFromSingleWorkspace: workspaceSelection.assumedFromSingleWorkspace,
    taskTitle: args.task_title,
    successSignal: args.success_signal,
    requestedBy: "manager",
  });

  const result = await submitUserTaskToEmployee({
    agentId: employee.id,
    text: taskDraft.goal,
    title: taskDraft.title,
    workspaceId: workspaceSelection.workspace?.id || null,
    requestedBy: "manager",
    taskDraft,
  });
  const latestSnapshot = buildSnapshot();

  return {
    output: {
      ok: true,
      employee: summarizeEmployee(employee, latestSnapshot),
      taskId: result.task?.id || null,
      conversationId: result.conversation?.id || null,
      taskDraft,
      message: taskDraft.managerSummary,
    },
    clientAction: buildTaskDetailActionFromStoredTask(result.task, latestSnapshot, {
      description: "任务已经交给这位员工，先看任务详情；如果需要，再从详情页进入直连。",
      label: `查看 ${employee.name} 的任务`,
    }),
  };
}

async function getEmployeeStatusTool(args = {}) {
  const snapshot = buildSnapshot();
  const matches = resolveEmployeeMatches(args.employee_ref, snapshot);
  if (matches.length === 0) {
    return {
      output: {
        ok: false,
        error: "EMPLOYEE_NOT_FOUND",
        message: "没有找到对应的数字员工。",
        suggestions: snapshot.agents.map((agent) => agent.name),
      },
      clientAction: null,
    };
  }

  if (matches.length > 1) {
    return {
      output: {
        ok: false,
        error: "EMPLOYEE_AMBIGUOUS",
        message: "找到多位可能的数字员工，需要你确认。",
        matches: matches.map((agent) => ({
          id: agent.id,
          name: agent.name,
          deviceName: agent.deviceName,
        })),
      },
      clientAction: null,
    };
  }

  const employee = summarizeEmployee(matches[0], snapshot);
  const recentConversation = employee.conversationId
    ? store.getConversation(employee.conversationId)
    : store.listConversationsByAgent(matches[0].id).sort(compareByRecency)[0] || null;
  const currentTask =
    snapshot.tasks.find((task) => task.agentId === matches[0].id && task.active) ||
    snapshot.tasks.find((task) => task.agentId === matches[0].id) ||
    null;

  return {
    output: {
      ok: true,
      employee,
      task: currentTask,
    },
    clientAction:
      buildTaskDetailAction(currentTask, {
        description: "先查看这位员工当前任务的细节；如果需要，再从详情页进入直连。",
        label: `查看 ${matches[0].name} 的当前任务`,
      }) ||
      buildEmployeeDetailAction(matches[0], recentConversation, {
        description: "查看这位员工的执行细节；如果需要，你可以继续直接指导他。",
      }),
  };
}

async function diagnoseEmployeeIssueTool(args = {}) {
  const snapshot = buildSnapshot();
  const matches = resolveEmployeeMatches(args.employee_ref, snapshot);

  if (matches.length === 0) {
    const onboardingGuidance = searchManagerKnowledge(
      MANAGER_KNOWLEDGE_BASE,
      `新 Agent 接入 onboarding ${normalizeText(args.employee_ref)}`
    );

    return {
      output: {
        ok: false,
        error: "EMPLOYEE_NOT_FOUND",
        message: "当前没有找到这位数字员工，看起来像是还没成功接入，或者名字和你输入的不一致。",
        onboardingGuidance: onboardingGuidance.map((article) => ({
          id: article.id,
          title: article.title,
          summary: article.summary,
        })),
      },
      clientAction: null,
    };
  }

  if (matches.length > 1) {
    return {
      output: {
        ok: false,
        error: "EMPLOYEE_AMBIGUOUS",
        message: "匹配到多位员工，需要更具体一点。",
        matches: matches.map((agent) => ({
          id: agent.id,
          name: agent.name,
          deviceName: agent.deviceName,
        })),
      },
      clientAction: null,
    };
  }

  const agent = matches[0];
  const employee = summarizeEmployee(agent, snapshot);
  const task = getActiveTaskForAgent(agent, snapshot);
  const workspaces = (snapshot.workspaces || []).filter((workspace) => workspace.employeeId === agent.id);
  let diagnosis = "";
  let recommendedAction = "";

  if (!agent.online && task?.active) {
    diagnosis = `这位员工当前离线，但手上的任务“${task.title}”还没有结束。`;
    recommendedAction = "优先判断是继续等待、重新分派，还是你直接介入。";
  } else if (task?.blocked) {
    diagnosis = `这位员工当前任务“${task.title}”已经阻塞。`;
    recommendedAction = normalizeText(task.blockedReason)
      ? `阻塞原因是：${task.blockedReason}。建议先追这个阻塞点。`
      : "建议先查看任务详情，确认阻塞点。";
  } else if (task?.active && isOlderThan(task.updatedAt, STALE_TASK_MINUTES)) {
    diagnosis = `这位员工当前任务“${task.title}”已经 ${formatRelativeMinutes(task.updatedAt)} 没有新进展。`;
    recommendedAction = "建议先催他汇报当前卡点和下一步计划。";
  } else if (agent.online && isOlderThan(agent.lastSeenAt, STALE_AGENT_MINUTES)) {
    diagnosis = "这位员工显示在线，但最近心跳偏旧。";
    recommendedAction = "建议先发一条跟进消息，确认不是假在线。";
  } else if (workspaces.length === 0) {
    diagnosis = "这位员工已经注册，但当前没有声明任何工作区。";
    recommendedAction = "这通常意味着 onboarding 不完整，经理后续不容易按目录或仓库给他派活。";
  } else if (!agent.online) {
    diagnosis = "这位员工当前离线。";
    recommendedAction = "如果他本该在线，优先检查设备是否休眠、进程是否退出、Hub 地址和 token 是否正确。";
  } else if (task?.active) {
    diagnosis = `这位员工当前在线，正在处理“${task.title}”。`;
    recommendedAction = "当前没有明显异常；如果你想介入，更适合先让他汇报最新进度。";
  } else {
    diagnosis = "这位员工当前在线，但没有正在推进的任务。";
    recommendedAction = "如果你预期他应该在工作，可以直接分派新任务，或先让他汇报当前状态。";
  }

  const recentConversation =
    (task?.conversationId && store.getConversation(task.conversationId)) ||
    store.listConversationsByAgent(agent.id).sort(compareByRecency)[0] ||
    null;

  return {
    output: {
      ok: true,
      employee,
      task: task || null,
      workspaceCount: workspaces.length,
      diagnosis,
      recommendedAction,
    },
    clientAction:
      buildTaskDetailAction(task, {
        label: "查看关联任务",
        description: "先看这条任务的细节，再决定是否需要继续催办或改派。",
      }) ||
      buildEmployeeDetailAction(agent, recentConversation, {
        label: `查看 ${agent.name} 的详情`,
        description: "查看这位员工当前的工作区、状态和最近对话。",
      }),
  };
}

async function ensureConversationForEmployee(agent, preferredConversationId = null) {
  let conversation = preferredConversationId ? store.getConversation(preferredConversationId) : null;
  if (!conversation) {
    conversation = store.listConversationsByAgent(agent.id).sort(compareByRecency)[0] || null;
  }

  if (!conversation) {
    conversation = await store.createConversation(agent.id, {
      title: "New chat",
      deviceId: agent.deviceId,
      deviceName: agent.deviceName,
    });
  }

  return conversation;
}

async function sendManagerFollowUpToEmployee({
  agent,
  messageText,
  task = null,
  preferredConversationId = null,
}) {
  const conversation = await ensureConversationForEmployee(
    agent,
    preferredConversationId || task?.conversationId || null
  );
  const directMessage = {
    id: randomUUID(),
    role: "user",
    text: normalizeText(messageText),
    agentId: agent.id,
    status: agentClients.has(agent.id) ? "sent" : "queued",
    createdAt: new Date().toISOString(),
  };

  await store.addMessage(conversation.id, directMessage);
  if (agentClients.has(agent.id)) {
    await deliverMessageToAgent(agent.id, conversation.id, directMessage, null);
  }
  broadcastSnapshot();

  return {
    conversation,
    message: directMessage,
  };
}

async function followUpWithEmployeeTool(args = {}) {
  const snapshot = buildSnapshot();
  const matches = resolveEmployeeMatches(args.employee_ref, snapshot);
  if (matches.length === 0) {
    return {
      output: {
        ok: false,
        error: "EMPLOYEE_NOT_FOUND",
        message: "没有找到要跟进的数字员工。",
      },
      clientAction: null,
    };
  }

  if (matches.length > 1) {
    return {
      output: {
        ok: false,
        error: "EMPLOYEE_AMBIGUOUS",
        message: "匹配到多位员工，需要更具体一点。",
        matches: matches.map((agent) => ({
          id: agent.id,
          name: agent.name,
          deviceName: agent.deviceName,
        })),
      },
      clientAction: null,
    };
  }

  const agent = matches[0];
  let task = null;
  if (normalizeText(args.task_ref)) {
    const taskMatches = resolveTaskMatches(snapshot, args.task_ref, agent.id);
    if (taskMatches.length === 1) {
      task = taskMatches[0];
    }
  } else {
    task = getActiveTaskForAgent(agent, snapshot);
  }

  const result = await sendManagerFollowUpToEmployee({
    agent,
    messageText: args.message,
    task,
  });

  return {
    output: {
      ok: true,
      employee: summarizeEmployee(agent, buildSnapshot()),
      task: task || null,
      conversationId: result.conversation.id,
      queued: !agentClients.has(agent.id),
      message: agentClients.has(agent.id)
        ? `我已经把跟进消息发给 ${agent.name} 了。`
        : `${agent.name} 当前离线，我已经把这条跟进消息排队，等他重新连线后会自动送达。`,
    },
    clientAction: buildEmployeeDetailAction(agent, result.conversation, {
      label: `进入与 ${agent.name} 的直连`,
      description: "进入这位员工的直连页，继续补充要求或等待他的回复。",
    }),
  };
}

const managerToolRegistry = createManagerToolRegistry({
  get_onboarding_guide: getOnboardingGuideTool,
  search_manager_knowledge: searchManagerKnowledgeTool,
  list_employees: listEmployeesTool,
  list_attention_items: listAttentionItemsTool,
  list_tasks: listTasksTool,
  get_task_status: getTaskStatusTool,
  list_workspaces: listWorkspacesTool,
  resolve_workspace_for_employee: resolveWorkspaceForEmployeeTool,
  list_approvals: listApprovalsTool,
  resolve_approval: resolveApprovalTool,
  assign_task_to_employee: assignTaskToEmployeeTool,
  get_employee_status: getEmployeeStatusTool,
  diagnose_employee_issue: diagnoseEmployeeIssueTool,
  follow_up_with_employee: followUpWithEmployeeTool,
  switch_to_employee_chat: (args) => switchToEmployeeChat(args.employee_ref),
});

function buildResponsesManagerTools() {
  return managerToolRegistry.buildResponsesTools();
}

function buildChatCompletionManagerTools() {
  return managerToolRegistry.buildChatCompletionTools();
}

async function executeManagerTool(name, rawArguments) {
  return managerToolRegistry.execute(name, rawArguments);
}

async function createOpenAIManagerResponse(input, previousResponseId = null) {
  return fetchJsonWithTimeout(`${MANAGER_BASE_URL}/responses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${MANAGER_API_KEY}`,
    },
    body: JSON.stringify({
      model: MANAGER_MODEL,
      instructions: MANAGER_PROMPT,
      input,
      previous_response_id: previousResponseId || undefined,
      tools: buildResponsesManagerTools(),
      parallel_tool_calls: false,
      reasoning: { effort: MANAGER_REASONING_EFFORT },
      text: { verbosity: MANAGER_TEXT_VERBOSITY },
    }),
  });
}

function buildManagerChatHistory() {
  return [
    { role: "system", content: MANAGER_PROMPT },
    ...store
      .listManagerMessages()
      .filter((message) => ["user", "assistant"].includes(message.role) && normalizeText(message.text))
      .map((message) => ({
        role: message.role,
        content: normalizeText(message.text),
      })),
  ];
}

async function createCompatibleChatManagerResponse(messages) {
  const payload = {
    model: MANAGER_MODEL,
    messages,
    tools: buildChatCompletionManagerTools(),
    tool_choice: "auto",
    temperature: 0.2,
  };

  if (MANAGER_PROVIDER === "zhipu") {
    payload.thinking = { type: "disabled" };
    payload.do_sample = false;
    payload.max_tokens = 1024;
  }

  return fetchJsonWithTimeout(`${MANAGER_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${MANAGER_API_KEY}`,
    },
    body: JSON.stringify(payload),
  });
}

function extractManagerResponseText(response) {
  if (normalizeText(response?.output_text)) {
    return normalizeText(response.output_text);
  }

  const textParts = [];
  for (const item of response?.output || []) {
    if (item.type !== "message" || !Array.isArray(item.content)) {
      continue;
    }

    for (const content of item.content) {
      if (content.type === "output_text" && normalizeText(content.text)) {
        textParts.push(normalizeText(content.text));
      }
    }
  }

  return textParts.join("\n").trim();
}

async function runOpenAIManager(text) {
  const managerState = store.getManagerState();
  let previousResponseId = managerState.previousResponseId || null;
  let response;

  try {
    response = await createOpenAIManagerResponse(
      [{ role: "user", content: text }],
      previousResponseId
    );
  } catch (error) {
    if (!previousResponseId) {
      throw error;
    }

    // If the previous response cannot be resumed, start a fresh manager thread.
    previousResponseId = null;
    await store.setManagerPreviousResponseId(null);
    response = await createOpenAIManagerResponse([{ role: "user", content: text }], null);
  }

  let clientAction = null;

  for (let index = 0; index < MANAGER_MAX_TOOL_LOOPS; index += 1) {
    const functionCalls = (response.output || []).filter(
      (item) => item.type === "function_call"
    );
    if (functionCalls.length === 0) {
      break;
    }

    const toolOutputs = [];
    for (const call of functionCalls) {
      const result = await executeManagerTool(call.name, call.arguments);
      if (!clientAction && result.clientAction) {
        clientAction = result.clientAction;
      }

      toolOutputs.push({
        type: "function_call_output",
        call_id: call.call_id,
        output: JSON.stringify(result.output),
      });
    }

    response = await createOpenAIManagerResponse(toolOutputs, response.id);
  }

  await store.setManagerPreviousResponseId(response.id || previousResponseId || null);

  return {
    text:
      extractManagerResponseText(response) ||
      "我已经拿到了当前状态，但这次没有生成可展示的经理回复。",
    action: clientAction,
  };
}

function normalizeChatToolCalls(toolCalls) {
  if (!Array.isArray(toolCalls)) {
    return [];
  }

  return toolCalls
    .map((toolCall) => ({
      id: normalizeText(toolCall?.id),
      type: "function",
      function: {
        name: normalizeText(toolCall?.function?.name),
        arguments: normalizeText(toolCall?.function?.arguments) || "{}",
      },
    }))
    .filter((toolCall) => toolCall.id && toolCall.function.name);
}

function extractCompatibleChatMessage(response) {
  return response?.choices?.[0]?.message || null;
}

function extractCompatibleChatText(response) {
  const content = response?.choices?.[0]?.message?.content;
  if (typeof content === "string") {
    return normalizeText(content);
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((item) => {
      if (typeof item === "string") {
        return item;
      }

      if (item?.type === "text") {
        return item.text;
      }

      return "";
    })
    .map((item) => normalizeText(item))
    .filter(Boolean)
    .join("\n")
    .trim();
}

async function runCompatibleChatManager() {
  const workingMessages = buildManagerChatHistory();
  let response = await createCompatibleChatManagerResponse(workingMessages);
  let clientAction = null;

  for (let index = 0; index < MANAGER_MAX_TOOL_LOOPS; index += 1) {
    const assistantMessage = extractCompatibleChatMessage(response);
    const toolCalls = normalizeChatToolCalls(assistantMessage?.tool_calls);

    if (toolCalls.length === 0) {
      break;
    }

    workingMessages.push({
      role: "assistant",
      content: typeof assistantMessage?.content === "string" ? assistantMessage.content : "",
      tool_calls: toolCalls,
    });

    for (const toolCall of toolCalls) {
      const result = await executeManagerTool(
        toolCall.function.name,
        toolCall.function.arguments
      );
      if (!clientAction && result.clientAction) {
        clientAction = result.clientAction;
      }

      workingMessages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: JSON.stringify(result.output),
      });
    }

    response = await createCompatibleChatManagerResponse(workingMessages);
  }

  await store.setManagerPreviousResponseId(null);

  return {
    text:
      extractCompatibleChatText(response) ||
      "我已经拿到了当前状态，但这次没有生成可展示的经理回复。",
    action: clientAction,
  };
}

function findMentionedAgent(snapshot, text) {
  const lowered = normalizeText(text).toLowerCase();
  if (!lowered) {
    return null;
  }

  return [...snapshot.agents]
    .sort((left, right) => right.name.length - left.name.length)
    .find((agent) => {
      const candidates = [agent.name, agent.id, agent.deviceName].filter(Boolean);
      return candidates.some((item) => lowered.includes(item.toLowerCase()));
    });
}

function getLatestAssistantManagerText() {
  const messages = store.listManagerMessages();
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant" && normalizeText(message.text)) {
      return normalizeText(message.text);
    }
  }

  return "";
}

function isEmployeeRosterQuestion(text) {
  return /(谁在线|谁离线|在线员工|离线员工|当前有哪些员工|现在有哪些员工|员工有哪些|有哪些员工|员工列表|当前员工|数字员工有哪些|当前有谁在线)/.test(
    normalizeText(text)
  );
}

function isGenericEmployeeReferenceCandidate(candidate) {
  const normalized = normalizeText(candidate).toLowerCase();
  if (!normalized) {
    return false;
  }

  if (
    /^(员工|数字员工|员工们|所有员工|全部员工|在线员工|离线员工|agent|agents|员工列表|当前员工|谁在线|谁离线)$/i.test(
      normalized
    )
  ) {
    return true;
  }

  return /^((当前|现在|哪些|哪个|谁|在线|离线|所有|全部|数字|位|个|有|在|的|员工|agent|agents)\s*)+$/i.test(
    normalized
  );
}

function shouldTreatAsDirectChatClarificationReply(text) {
  const normalized = normalizeText(text);
  if (!normalized) {
    return false;
  }

  if (
    isEmployeeRosterQuestion(normalized) ||
    isManagerIdentityQuestion(normalized) ||
    isManagerCapabilityQuestion(normalized) ||
    isOnboardingGuideQuestion(normalized) ||
    isManagerKnowledgeQuestion(normalized) ||
    isAttentionQuestion(normalized) ||
    /(任务|进度|状态|做到哪|完成没|卡住|审批|授权|批准|风险)/.test(normalized)
  ) {
    return false;
  }

  return true;
}

function extractEmployeeReferenceCandidate(text) {
  return normalizeText(text)
    .replace(/^(帮我|麻烦你|请|直接|现在|我要|我想|给我|继续|那就)/g, "")
    .replace(
      /(切到|直连|对话|连接|进入|打开|连到|切换到|带我去|跳到|切过去|连过去|去找|找一下)/g,
      " "
    )
    .replace(/\b(和|与|到|去|一下)\b/g, " ")
    .replace(/[，。！？,.!?:："'“”‘’]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function analyzeDirectChatIntent(text, snapshot) {
  const normalizedText = normalizeText(text);
  const directVerbRequested =
    /(切到|直连|对话|连接|进入|打开|连到|切换到|带我去|跳到|切过去|连过去)/.test(
      normalizedText
    );
  const clarificationRequested =
    /(没识别出目标|需要你确认|匹配到多位|找到多位|当前员工有|请更具体|说一下具体是哪位|指出具体员工名)/.test(
      getLatestAssistantManagerText()
    );
  const clarificationReply =
    clarificationRequested && shouldTreatAsDirectChatClarificationReply(normalizedText);

  if (!directVerbRequested && !clarificationReply) {
    return null;
  }

  const candidate = extractEmployeeReferenceCandidate(normalizedText);
  if (!candidate || isGenericEmployeeReferenceCandidate(candidate)) {
    return {
      type: "missing",
      candidate: "",
      matches: [],
    };
  }

  const matches = resolveEmployeeMatches(candidate, snapshot);
  if (matches.length === 1) {
    return {
      type: "resolved",
      candidate,
      matches,
    };
  }

  if (matches.length > 1) {
    return {
      type: "ambiguous",
      candidate,
      matches,
    };
  }

  return {
    type: "not_found",
    candidate,
    matches: [],
  };
}

function extractStructuredRef(text, pattern) {
  const match = String(text || "").match(pattern);
  return match?.[0] || "";
}

function describeManagerModelError(error) {
  const raw = normalizeText(error?.message || "");
  const lowered = raw.toLowerCase();

  if (
    lowered.includes("超时") ||
    lowered.includes("timeout") ||
    lowered.includes("timed out") ||
    lowered.includes("aborterror")
  ) {
    return "经理层大模型响应超时，当前模型可能不可用、网络不稳，或这把 key 没有匹配到合适的模型资源包。";
  }

  if (lowered.includes("insufficient_quota")) {
    return "经理层大模型暂时不可用，当前 API 额度不足。";
  }

  if (lowered.includes("invalid_api_key")) {
    return "经理层大模型暂时不可用，当前 API Key 无效。";
  }

  if (lowered.includes("rate_limit") || lowered.includes("429")) {
    return "经理层大模型暂时不可用，当前请求过于频繁。";
  }

  if (
    (lowered.includes("model") &&
      (lowered.includes("not found") ||
        lowered.includes("does not exist") ||
        lowered.includes("unsupported") ||
        lowered.includes("invalid") ||
        lowered.includes("unavailable"))) ||
    lowered.includes("资源包") ||
    lowered.includes("套餐") ||
    lowered.includes("适用于glm") ||
    lowered.includes("model not found")
  ) {
    return "经理层大模型暂时不可用，当前模型可能没有开通，或不在这把 key 的可用资源包内。";
  }

  if (lowered.includes("401") || lowered.includes("unauthorized")) {
    return "经理层大模型暂时不可用，当前鉴权失败。";
  }

  if (lowered.includes("403") || lowered.includes("permission")) {
    return "经理层大模型暂时不可用，当前权限不足。";
  }

  return "经理层大模型暂时不可用，我先回退到本地摘要继续工作。";
}

async function runLocalManager(text) {
  const snapshot = buildSnapshot();
  const mentionedAgent = findMentionedAgent(snapshot, text);
  const directChatIntent = analyzeDirectChatIntent(text, snapshot);
  const isApprovalDecision = /(批准|同意|通过|驳回|拒绝)/.test(text);

  if (isManagerIdentityQuestion(text)) {
    return {
      text: buildManagerIdentityReply(snapshot),
      action: null,
    };
  }

  if (isManagerCapabilityQuestion(text)) {
    return {
      text: buildManagerCapabilityReply(snapshot),
      action: null,
    };
  }

  if (isOnboardingGuideQuestion(text)) {
    const guide = getOnboardingGuideTool({ runtime: /claude|openai|echo/i.test(text) ? "other" : "codex" });
    return {
      text: guide.output.replyText,
      action: null,
    };
  }

  if (isManagerKnowledgeQuestion(text)) {
    const knowledgeResult = searchManagerKnowledgeTool({ query: text });
    return {
      text: formatKnowledgeReply(text, knowledgeResult.output?.matches || []),
      action: null,
    };
  }

  if (isAttentionQuestion(text)) {
    const result = await listAttentionItemsTool();
    return {
      text: formatAttentionReply(snapshot, result.output?.items || []),
      action: result.clientAction,
    };
  }

  if (isApprovalDecision) {
    const explicitApprovalId = extractStructuredRef(
      text,
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i
    );
    const decision = /(驳回|拒绝)/.test(text) ? "rejected" : "approved";
    const result = await resolveApprovalDecision({
      approvalRef: explicitApprovalId || null,
      employeeRef: mentionedAgent?.name || null,
      taskRef: explicitApprovalId ? null : text,
      decision,
      note: text,
      decidedBy: "manager",
    });

    return {
      text: result.message || "审批结果已记录。",
      action: null,
      };
  }

  if (mentionedAgent && isEmployeeDiagnosisQuestion(text)) {
    const result = await diagnoseEmployeeIssueTool({
      employee_ref: mentionedAgent.name,
    });
    if (result.output?.ok) {
      return {
        text: `${result.output.diagnosis} ${result.output.recommendedAction}`.trim(),
        action: result.clientAction,
      };
    }
  }

  if (directChatIntent) {
    if (directChatIntent.type === "missing") {
      return {
        text: `我可以帮你切到具体员工的直连，但你还没说是哪位。当前员工有：${snapshot.agents
          .map((agent) => agent.name)
          .join("、")}。`,
        action: null,
      };
    }

    if (directChatIntent.type === "ambiguous") {
      return {
        text: `“${directChatIntent.candidate}”目前会匹配到多位员工：${directChatIntent.matches
          .map((agent) => agent.name)
          .join("、")}。请直接说具体员工名，我再帮你切过去。`,
        action: null,
      };
    }

    if (directChatIntent.type === "not_found") {
      return {
        text: `我还没找到“${directChatIntent.candidate}”对应的员工。当前员工有：${snapshot.agents
          .map((agent) => agent.name)
          .join("、")}。`,
        action: null,
      };
    }

    if (directChatIntent.type === "resolved") {
      const result = await switchToEmployeeChat(directChatIntent.matches[0].name);
      if (!result.output.ok) {
        return {
          text: result.output.message || "我还没找到要切换的员工。",
          action: null,
        };
      }

      const taskTitle =
        result.output.currentTask?.title || result.output.agent.currentTaskTitle || "暂无明确任务";
      return {
        text: `已切到和 ${directChatIntent.matches[0].name} 的直连对话。当前他正在处理“${taskTitle}”。`,
        action: result.clientAction,
      };
    }
  }

  const delegationIntent = parseDelegationIntent(text, snapshot);
  if (delegationIntent) {
    if (!delegationIntent.ok) {
      return {
        text: delegationIntent.message || "我理解你在分派任务，但还缺少必要信息。",
        action: null,
      };
    }

    const assignment = await assignTaskToEmployeeTool({
      employee_ref: delegationIntent.employee.name,
      goal: delegationIntent.goal,
      workspace_ref: delegationIntent.workspace?.name || delegationIntent.workspace?.path || "",
    });
    if (!assignment.output?.ok) {
      return {
        text: assignment.output?.message || "这次任务分派没有成功。",
        action: null,
      };
    }

    return {
      text:
        assignment.output?.message ||
        `已把任务“${delegationIntent.goal}”交给 ${delegationIntent.employee.name}。`,
      action: assignment.clientAction,
    };
  }

  if (
    mentionedAgent &&
    /(催一下|跟进一下|提醒一下|问一下|告诉|通知|让.*汇报|继续推进|先停一下|暂停一下|补充要求)/.test(
      text
    )
  ) {
    const result = await followUpWithEmployeeTool({
      employee_ref: mentionedAgent.name,
      message: buildFollowUpMessage(text, mentionedAgent.name),
      task_ref: text,
    });

    return {
      text: result.output?.message || `我已经替你跟进 ${mentionedAgent.name} 了。`,
      action: result.clientAction,
    };
  }

  if (/(切到|直连|对话|连接|进入|打开|连到|切换到|带我去|跳到)/.test(text)) {
    if (!mentionedAgent) {
      return {
        text: `我可以帮你切到具体员工的直连，但我还没识别出目标。当前员工有：${snapshot.agents
          .map((agent) => agent.name)
          .join("、")}。`,
        action: null,
      };
    }

    const result = await switchToEmployeeChat(mentionedAgent.name);
    if (!result.output.ok) {
      return {
        text: result.output.message || "我还没找到要切换的员工。",
        action: null,
      };
    }

    const taskTitle =
      result.output.currentTask?.title || result.output.agent.currentTaskTitle || "暂无明确任务";
    return {
      text: `已切到和 ${mentionedAgent.name} 的直连对话。当前他正在处理“${taskTitle}”。`,
      action: result.clientAction,
    };
  }

  if (
    (mentionedAgent && isEmployeeDetailQuestion(text)) ||
    (/(员工|agent)/i.test(text) && isEmployeeDetailQuestion(text)) ||
    /(在线员工|离线员工)/.test(text)
  ) {
    const selectedAgents = selectEmployeesForDetail(snapshot, text, mentionedAgent);
    return {
      text: formatEmployeeDetailReply(snapshot, selectedAgents),
      action: null,
    };
  }

  if (mentionedAgent && /(进度|在做|干啥|做啥|状态)/.test(text)) {
    const result = await getEmployeeStatusTool({
      employee_ref: mentionedAgent.name,
    });
    const employee = result.output?.employee || summarizeEmployee(mentionedAgent, snapshot);
    const currentTask = result.output?.task || null;
    return {
      text: `${employee.name} 当前在 ${employee.deviceName} 上，${
        employee.online ? "在线" : "离线"
      }。${
        employee.currentTaskTitle
          ? `他现在的任务是“${employee.currentTaskTitle}”，状态是 ${employee.currentTaskStatus}。${employee.currentTaskSummary}`
          : "当前没有正在推进的任务。"
      }`,
      action: result.clientAction,
    };
  }

  if (/(任务|进度|状态|做到哪|完成没|卡住)/.test(text)) {
    const result = await getTaskStatusTool({
      task_ref: text,
    });

    if (result.output?.ok && result.output.task) {
      const task = result.output.task;
      return {
        text: `${task.title} 当前由 ${task.agentName || "未分配员工"} 在 ${
          task.deviceName || "当前设备"
        } 上推进，状态是 ${task.statusLabel}。${task.progressSummary}${
          task.blockedReason ? ` 当前阻塞原因：${task.blockedReason}。` : ""
        }`,
        action: result.clientAction,
      };
    }
  }

  if (/(员工|agent|谁在线|有哪些)/i.test(text)) {
    return {
      text: formatEmployeeListReply(snapshot),
      action: null,
    };
  }

  if (/(做什么|最忙|卡住|任务|进度)/.test(text)) {
    return {
      text: formatTaskListReply(snapshot),
      action: null,
    };
  }

  if (/(工作区|workspace|目录|仓库|repo)/i.test(text)) {
    return {
      text: formatWorkspaceListReply(snapshot),
      action: null,
    };
  }

  if (/(审批|授权|批准|风险)/.test(text)) {
    const pendingApprovals = (snapshot.approvals || []).filter(
      (approval) => approval.status === "pending"
    );
    return {
      text: formatApprovalListReply(snapshot),
      action:
        pendingApprovals.length === 1
          ? buildApprovalTaskAction(snapshot, pendingApprovals[0], {
              description: "这条任务正在等待你的批准或拒绝，先看任务详情和上下文，再做决定。",
              label: "查看待审批任务",
            })
          : null,
    };
  }

  return {
    text: buildManagerCapabilityReply(snapshot, "我还没完全理解你的意思，不过你可以直接这样使唤我："),
    action: null,
  };
}

async function runManager(text) {
  const snapshot = buildSnapshot();

  if (shouldPreferDeterministicManagerFlow(text, snapshot)) {
    return runLocalManager(text);
  }

  if (MANAGER_PROVIDER === "openai") {
    try {
      return await runOpenAIManager(text);
    } catch (error) {
      const fallback = await runLocalManager(text);
      return {
        text: [
          `${describeManagerModelError(error)} 已自动回退到本地摘要。`,
          fallback.text,
        ].join("\n\n"),
        action: fallback.action || null,
      };
    }
  }

  if (["zhipu", "openai-compatible"].includes(MANAGER_PROVIDER)) {
    try {
      return await runCompatibleChatManager(text);
    } catch (error) {
      const fallback = await runLocalManager(text);
      return {
        text: [
          `${describeManagerModelError(error)} 已自动回退到本地摘要。`,
          fallback.text,
        ].join("\n\n"),
        action: fallback.action || null,
      };
    }
  }

  return runLocalManager(text);
}

let managerQueue = Promise.resolve();

function enqueueManagerTask(task) {
  const nextTask = managerQueue.then(task, task);
  managerQueue = nextTask.catch(() => {});
  return nextTask;
}

app.use(express.json());
app.use(
  express.static(join(__dirname, "..", "public"), {
    setHeaders(response) {
      // AgentHub is iterating quickly across devices and browsers; prefer
      // freshness over asset caching so mobile clients don't get stuck on
      // stale HTML/JS after auth or deploy transitions.
      response.set("Cache-Control", "no-store");
    },
  })
);

app.get("/api/health", (_request, response) => {
  const snapshot = buildSnapshot();
  response.json({
    ok: true,
    port: PORT,
    onlineAgents: [...agentClients.keys()],
    conversationCount: store.listConversations().length,
    managerProvider: MANAGER_PROVIDER,
    workspaceCount: snapshot.workspaces?.length || 0,
    taskCount: snapshot.tasks?.length || 0,
    pendingApprovalCount: snapshot.approvals?.filter((item) => item.status === "pending").length || 0,
  });
});

app.get("/api/state", (request, response) => {
  if (!isExpectedToken(APP_TOKEN, readBearerToken(request))) {
    response.status(401).json({
      ok: false,
      error: "UNAUTHORIZED",
      message: "读取状态需要有效的 APP_TOKEN",
    });
    return;
  }

  response.set("Cache-Control", "no-store");
  response.json(buildSnapshot());
});

wss.on("connection", (socket) => {
  socket.on("message", async (raw) => {
    try {
      const payload = JSON.parse(String(raw));

      if (payload.type === "hello" && payload.role === "app") {
        if (!isExpectedToken(APP_TOKEN, payload.token)) {
          sendJson(socket, {
            type: "auth_required",
            message: "这个 AgentHub 需要有效的 APP_TOKEN。",
          });
          socket.close();
          return;
        }

        socket.clientRole = "app";
        socket.authenticated = true;
        socket.clientId = socket.clientId || randomUUID();
        socket.appOrigin = normalizeHttpOrigin(payload.appOrigin);
        if (socket.appOrigin) {
          lastKnownAppOrigin = socket.appOrigin;
        }
        appClients.add(socket);
        sendJson(socket, {
          type: "snapshot",
          data: buildSnapshot(),
          clientId: socket.clientId,
        });
        return;
      }

      const isAgentRegistration =
        (payload.type === "hello" && payload.role === "agent") ||
        payload.type === "employee.register";

      if (isAgentRegistration) {
        if (!isExpectedToken(AGENT_TOKEN, payload.token)) {
          sendJson(socket, {
            type: "error",
            message: "Agent 鉴权失败，请检查 AGENT_TOKEN。",
          });
          socket.close();
          return;
        }

        const agentId = payload.agentId || payload.employeeId || "local-ai";
        const agentName = payload.employeeName || payload.name || agentId;
        const runtime = payload.runtime || payload.mode || "echo";
        socket.clientRole = "agent";
        socket.authenticated = true;
        socket.agentId = agentId;

        const normalizedWorkspaces = normalizeWorkspaceList(payload.workspaces, {
          agentId,
          name: agentName,
          deviceId: normalizeDeviceId(payload.deviceId),
          deviceName: normalizeDeviceName(payload.deviceName),
          mode: runtime,
          online: true,
        });

        agentClients.set(agentId, {
          socket,
          name: agentName,
          deviceId: normalizeDeviceId(payload.deviceId),
          deviceName: normalizeDeviceName(payload.deviceName),
          mode: runtime,
          recentCodexSessions: normalizeCodexSessions(payload.recentCodexSessions),
          defaultCodexWorkdir: normalizeText(payload.defaultCodexWorkdir) || null,
          workdirRoots: Array.isArray(payload.workdirRoots)
            ? payload.workdirRoots.map((value) => normalizeText(value)).filter(Boolean)
            : [],
          workspaces: normalizedWorkspaces,
          lastSeenAt: new Date().toISOString(),
        });
        await store.upsertEmployee({
          id: agentId,
          name: agentName,
          deviceId: normalizeDeviceId(payload.deviceId),
          deviceName: normalizeDeviceName(payload.deviceName),
          runtime,
          version: normalizeText(payload.version) || null,
          capabilities: Array.isArray(payload.capabilities)
            ? payload.capabilities.map((value) => normalizeText(value)).filter(Boolean)
            : [],
          status: "idle",
          online: true,
          lastSeenAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        await store.upsertWorkspaces(normalizedWorkspaces);

        sendJson(socket, {
          type: "hello_ack",
          agentId,
          serverTime: new Date().toISOString(),
        });

        broadcastSnapshot();
        await flushQueuedMessages(agentId);
        return;
      }

      if (!socket.authenticated) {
        sendJson(socket, {
          type: "auth_required",
          message: "请先完成鉴权。",
        });
        socket.close();
        return;
      }

      if (payload.type === "create_conversation" && socket.clientRole === "app") {
        const agentId = normalizeText(payload.agentId);
        const agentConnection = agentClients.get(agentId);
        if (!agentId) {
          sendJson(socket, { type: "error", message: "创建会话需要 agentId" });
          return;
        }

        const codexSessionId = normalizeText(payload.codexSessionId);
        let conversation =
          codexSessionId &&
          store.findConversationByCodexSession(agentId, codexSessionId);

        if (!conversation) {
          conversation = await store.createConversation(agentId, {
            title: normalizeText(payload.title),
            deviceId: agentConnection?.deviceId || null,
            deviceName: agentConnection?.deviceName || null,
            codexWorkdir: normalizeText(payload.codexWorkdir),
            codexSessionId,
            codexThreadName: normalizeText(payload.codexThreadName),
            codexSessionUpdatedAt: normalizeText(payload.codexSessionUpdatedAt),
          });
          broadcastSnapshot();
        }

        sendJson(socket, {
          type: "conversation_opened",
          conversationId: conversation.id,
        });
        return;
      }

      if (payload.type === "open_codex_session" && socket.clientRole === "app") {
        const agentId = normalizeText(payload.agentId);
        const codexSessionId = normalizeText(payload.codexSessionId);
        const agentConnection = agentClients.get(agentId);

        if (!agentId || !codexSessionId) {
          sendJson(socket, {
            type: "error",
            message: "打开 Codex session 需要 agentId 和 codexSessionId",
          });
          return;
        }

        let conversation = store.findConversationByCodexSession(agentId, codexSessionId);

        if (!conversation) {
          conversation = await store.createConversation(agentId, {
            deviceId: agentConnection?.deviceId || null,
            deviceName: agentConnection?.deviceName || null,
            codexWorkdir: normalizeText(payload.codexWorkdir),
            codexSessionId,
            codexThreadName: normalizeText(payload.codexThreadName),
            codexSessionUpdatedAt: normalizeText(payload.codexSessionUpdatedAt),
          });
          broadcastSnapshot();
        } else if (
          (!conversation.codexThreadName && normalizeText(payload.codexThreadName)) ||
          (!conversation.codexWorkdir && normalizeText(payload.codexWorkdir))
        ) {
          conversation = await store.updateConversation(conversation.id, {
            codexThreadName: normalizeText(payload.codexThreadName),
            codexWorkdir:
              normalizeText(payload.codexWorkdir) || conversation.codexWorkdir || null,
            title:
              conversation.title && conversation.title !== "New chat"
                ? conversation.title
                : buildConversationTitle(payload.codexThreadName, "Codex Session"),
          });
          broadcastSnapshot();
        }

        sendJson(socket, {
          type: "conversation_opened",
          conversationId: conversation.id,
        });
        return;
      }

      if (payload.type === "list_agent_directories" && socket.clientRole === "app") {
        const agentId = normalizeText(payload.agentId);
        const agentConnection = agentClients.get(agentId);

        if (!agentConnection) {
          sendJson(socket, {
            type: "error",
            message: "目标数字员工当前不在线，无法读取目录",
          });
          return;
        }

        sendJson(agentConnection.socket, {
          type: "list_agent_directories",
          appClientId: socket.clientId || null,
          requestId: normalizeText(payload.requestId),
          path: normalizeText(payload.path),
        });
        return;
      }

      if (payload.type === "manager_message" && socket.clientRole === "app") {
        const text = normalizeText(payload.text);
        const clientMessageId = normalizeText(payload.clientMessageId);
        if (!text) {
          sendJson(socket, {
            type: "error",
            message: "发送给 AI经理 的消息不能为空",
          });
          return;
        }

        const existingMessage = store.findManagerMessageByClientMessageId(clientMessageId);
        if (existingMessage) {
          broadcastSnapshot();
          return;
        }

        const userMessage = await store.addManagerMessage({
          id: randomUUID(),
          clientMessageId,
          role: "user",
          text,
          status: "processing",
          createdAt: new Date().toISOString(),
        });
        broadcastSnapshot();

        enqueueManagerTask(async () => {
          try {
            const result = await runManager(text);
            await store.updateManagerMessage(userMessage.id, {
              status: "answered",
              answeredAt: new Date().toISOString(),
              errorMessage: null,
            });
            await store.addManagerMessage({
              id: randomUUID(),
              role: "assistant",
              text: result.text,
              action: result.action || null,
              createdAt: new Date().toISOString(),
            });
            broadcastSnapshot();

            if (result.action && socket.readyState === 1) {
              sendJson(socket, {
                type: "manager_action_requested",
                action: result.action,
              });
            }
          } catch (error) {
            await store.updateManagerMessage(userMessage.id, {
              status: "failed",
              failedAt: new Date().toISOString(),
              errorMessage: error.message || "AI经理 暂时不可用",
            });
            await store.addManagerMessage({
              id: randomUUID(),
              role: "assistant",
              text: `AI经理 这次没能完成处理：${error.message || "未知错误"}`,
              createdAt: new Date().toISOString(),
            });
            broadcastSnapshot();
          }
        });
        return;
      }

      if (payload.type === "user_message" && socket.clientRole === "app") {
        const text = normalizeText(payload.text);
        const requestedAgentId = normalizeText(payload.agentId);
        const requestedConversationId = normalizeText(payload.conversationId);
        const clientMessageId = normalizeText(payload.clientMessageId);
        let conversation = requestedConversationId
          ? store.getConversation(requestedConversationId)
          : null;
        let agentId = requestedAgentId;

        if (!text || !agentId) {
          if (conversation) {
            agentId = conversation.agentId;
          }
        }

        if (!text || !agentId) {
          sendJson(socket, {
            type: "error",
            message: "发送消息需要 text，以及 agentId 或 conversationId",
          });
          return;
        }

        await submitUserTaskToEmployee({
          agentId,
          text,
          requestedConversationId,
          clientMessageId,
          requestedBy: "human",
        });
        broadcastSnapshot();
        return;
      }

      if (payload.type === "delete_conversation" && socket.clientRole === "app") {
        const conversationId = normalizeText(payload.conversationId);
        if (!conversationId) {
          sendJson(socket, {
            type: "error",
            message: "删除会话需要 conversationId",
          });
          return;
        }

        const deletedConversation = await store.deleteConversation(conversationId);
        if (!deletedConversation) {
          sendJson(socket, {
            type: "error",
            message: "要删除的会话不存在",
          });
          return;
        }

        broadcastSnapshot();
        return;
      }

      if (payload.type === "approval_decision" && socket.clientRole === "app") {
        const result = await resolveApprovalDecision({
          approvalRef: normalizeText(payload.approvalId) || null,
          employeeRef: normalizeText(payload.employeeRef) || null,
          taskRef: normalizeText(payload.taskId) || null,
          decision: normalizeText(payload.decision) || "approved",
          note: normalizeText(payload.note) || "",
          decidedBy: "human",
        });

        sendJson(socket, {
          type: "approval_decision_result",
          approvalId: normalizeText(payload.approvalId) || null,
          result,
        });
        broadcastSnapshot();
        return;
      }

      if (payload.type === "agent_codex_sessions" && socket.clientRole === "agent") {
        const agentId = socket.agentId;
        if (!agentId) {
          return;
        }

        updateAgentConnection(agentId, {
          recentCodexSessions: normalizeCodexSessions(payload.sessions),
        });
        broadcastSnapshot();
        return;
      }

      if (payload.type === "agent_heartbeat" && socket.clientRole === "agent") {
        const agentId = socket.agentId;
        if (!agentId) {
          return;
        }

        const currentTaskId = normalizeText(payload.currentTaskId) || null;
        const currentRunId = normalizeText(payload.currentRunId) || null;
        const status = normalizeText(payload.status) || (currentTaskId ? "busy" : "idle");
        const lastSummary = normalizeText(payload.summary) || null;

        updateAgentConnection(agentId, {});
        await store.updateEmployee(agentId, {
          online: true,
          status,
          currentTaskId,
          currentRunId,
          lastSummary,
          lastSeenAt: new Date().toISOString(),
        });
        broadcastSnapshot();
        return;
      }

      if (payload.type === "agent_directory_list" && socket.clientRole === "agent") {
        const targetClient = findAppClient(normalizeText(payload.appClientId));
        if (!targetClient) {
          return;
        }

        sendJson(targetClient, {
          type: "agent_directory_list",
          agentId: socket.agentId,
          requestId: normalizeText(payload.requestId),
          path: normalizeText(payload.path),
          parentPath: normalizeText(payload.parentPath) || null,
          roots: Array.isArray(payload.roots) ? payload.roots : [],
          entries: Array.isArray(payload.entries) ? payload.entries : [],
          error: normalizeText(payload.error) || null,
        });
        return;
      }

      if (payload.type === "agent_status" && socket.clientRole === "agent") {
        const conversationId = normalizeText(payload.conversationId);
        const replyTo = normalizeText(payload.replyTo);
        const status = normalizeText(payload.status);

        if (!conversationId || !replyTo || !status) {
          return;
        }

        const patch = { status };

        if (status === "processing") {
          patch.processingAt = new Date().toISOString();
          patch.errorMessage = null;
        }

        if (status === "failed") {
          patch.failedAt = new Date().toISOString();
          patch.errorMessage = payload.error || "处理失败";
        }

        await store.updateMessage(conversationId, replyTo, patch);
        const linkedTask = store.findTaskBySourceMessageId(replyTo);
        if (linkedTask) {
          await store.updateTask(linkedTask.id, {
            status:
              status === "processing"
                ? "in_progress"
                : status === "failed"
                  ? "failed"
                  : linkedTask.status,
            runStatus:
              status === "processing"
                ? "running"
                : status === "failed"
                  ? "failed"
                  : linkedTask.runStatus,
            latestSummary:
              status === "processing"
                ? "数字员工已开始执行。"
                : payload.error || linkedTask.latestSummary,
            blockedReason: status === "failed" ? payload.error || "处理失败" : null,
          });
          await store.updateEmployee(socket.agentId, {
            status: status === "processing" ? "busy" : status === "failed" ? "blocked" : "idle",
            currentTaskId: status === "failed" ? linkedTask.id : linkedTask.id,
            currentRunId: linkedTask.runId || `run-${linkedTask.id}`,
            lastSummary:
              status === "processing"
                ? "已进入执行。"
                : payload.error || linkedTask.latestSummary,
            lastSeenAt: new Date().toISOString(),
          });
        }
        broadcastSnapshot();
        return;
      }

      if (payload.type === "task_progress" && socket.clientRole === "agent") {
        const replyTo = normalizeText(payload.replyTo);
        const taskId =
          normalizeText(payload.taskId) ||
          (replyTo ? store.findTaskBySourceMessageId(replyTo)?.id : null) ||
          null;
        if (!taskId) {
          return;
        }

        const task = store.getTask(taskId);
        if (!task) {
          return;
        }

        const nextTaskStatus =
          normalizeTaskStatus(payload.status, null) ||
          mapRunStatusToTaskStatus(payload.runStatus) ||
          task.status;

        await store.updateTask(task.id, {
          status: nextTaskStatus,
          runStatus: normalizeRunStatus(payload.runStatus) || task.runStatus,
          latestSummary: normalizeText(payload.summary) || task.latestSummary,
          blockedReason:
            nextTaskStatus === "blocked" || nextTaskStatus === "failed"
              ? normalizeText(payload.error) || task.blockedReason
              : null,
          outputRef:
            nextTaskStatus === "completed"
              ? normalizeText(payload.outputRef) || task.outputRef
              : task.outputRef,
        });
        await store.updateEmployee(socket.agentId, {
          status:
            nextTaskStatus === "completed"
              ? "idle"
              : nextTaskStatus === "failed" || nextTaskStatus === "blocked"
                ? "blocked"
                : "busy",
          currentTaskId: ["completed", "failed", "cancelled"].includes(nextTaskStatus)
            ? null
            : task.id,
          currentRunId:
            ["completed", "failed", "cancelled"].includes(nextTaskStatus)
              ? null
              : normalizeText(payload.runId) || task.runId || `run-${task.id}`,
          lastSummary: normalizeText(payload.summary) || task.latestSummary,
          lastSeenAt: new Date().toISOString(),
        });
        broadcastSnapshot();
        return;
      }

      if (payload.type === "approval.requested" && socket.clientRole === "agent") {
        const taskId = normalizeText(payload.taskId);
        if (!taskId) {
          return;
        }

        const task = store.getTask(taskId);
        if (!task) {
          return;
        }

        const approval = await store.createApproval({
          taskId,
          runId: normalizeText(payload.runId) || task.runId || `run-${task.id}`,
          requestedByEmployeeId: socket.agentId,
          reason: normalizeText(payload.reason) || "需要审批",
          scope: normalizeText(payload.scope) || null,
          requestedAction: normalizeText(payload.requestedAction) || null,
          riskLevel: normalizeText(payload.riskLevel) || "medium",
          status: "pending",
        });

        await store.updateTask(task.id, {
          status: "waiting_approval",
          runStatus: "waiting_approval",
          approvalState: "pending",
          approvalReason: approval.reason,
          latestSummary: `等待审批：${approval.reason}`,
          blockedReason: approval.reason,
        });
        await store.updateEmployee(socket.agentId, {
          status: "waiting_approval",
          currentTaskId: task.id,
          currentRunId: approval.runId || task.runId || `run-${task.id}`,
          lastSummary: `已发起审批：${approval.reason}`,
          lastSeenAt: new Date().toISOString(),
        });
        broadcastSnapshot();
        return;
      }

      if (payload.type === "agent_message" && socket.clientRole === "agent") {
        const text = normalizeText(payload.text);
        const conversationId = normalizeText(payload.conversationId);
        const agentId = socket.agentId;
        const taskId = normalizeText(payload.taskId);

        if (!text || !conversationId || !agentId) {
          return;
        }

        const conversation = store.getConversation(conversationId);
        if (!conversation) {
          return;
        }

        const codexSessionId = normalizeText(payload.codexSessionId);
        const codexThreadName = normalizeText(payload.codexThreadName);
        const codexSessionUpdatedAt = normalizeText(payload.codexSessionUpdatedAt);
        const codexWorkdir = normalizeText(payload.codexWorkdir);

        if (codexSessionId || codexThreadName || codexSessionUpdatedAt || codexWorkdir) {
          await store.updateConversation(conversationId, {
            codexWorkdir: codexWorkdir || conversation.codexWorkdir || null,
            codexSessionId: codexSessionId || conversation.codexSessionId || null,
            codexThreadName: codexThreadName || conversation.codexThreadName || null,
            codexSessionUpdatedAt:
              codexSessionUpdatedAt || conversation.codexSessionUpdatedAt || null,
            title:
              conversation.title && conversation.title !== "New chat"
                ? conversation.title
                : buildConversationTitle(
                    codexThreadName || conversation.codexThreadName,
                    conversation.title || "Codex Session"
                  ),
          });
        }

        const message = {
          id: randomUUID(),
          role: "assistant",
          text,
          agentId,
          replyTo: payload.replyTo || null,
          createdAt: new Date().toISOString(),
        };

        await store.addMessage(conversationId, message);

        if (payload.replyTo) {
          await store.updateMessage(conversationId, payload.replyTo, {
            status: "answered",
            answeredAt: new Date().toISOString(),
          });
        }

        const linkedTask =
          (taskId && store.getTask(taskId)) ||
          (payload.replyTo ? store.findTaskBySourceMessageId(payload.replyTo) : null);
        if (linkedTask) {
          await store.updateTask(linkedTask.id, {
            status: "completed",
            runStatus: "completed",
            latestSummary: text,
            outputRef: message.id,
            blockedReason: null,
            approvalState:
              linkedTask.approvalState === "pending" ? "approved" : linkedTask.approvalState,
          });
          await store.updateEmployee(socket.agentId, {
            status: "idle",
            currentTaskId: null,
            currentRunId: null,
            lastSummary: `刚完成：${linkedTask.title}`,
            lastSeenAt: new Date().toISOString(),
          });
        }

        broadcastSnapshot();
      }
    } catch (error) {
      sendJson(socket, {
        type: "error",
        message: error.message || "未知错误",
      });
    }
  });

  socket.on("close", () => {
    if (socket.clientRole === "app") {
      appClients.delete(socket);
      return;
    }

    if (socket.clientRole === "agent" && socket.agentId) {
      agentClients.delete(socket.agentId);
      store.markEmployeeOffline(socket.agentId).catch((error) => {
        console.error("Failed to mark employee offline:", error.message);
      });
      store.markEmployeeWorkspacesOffline(socket.agentId).catch((error) => {
        console.error("Failed to mark employee workspaces offline:", error.message);
      });
      broadcastSnapshot();
    }
  });
});

server.listen(PORT, HOST || undefined, () => {
  const displayHost = HOST || "0.0.0.0";
  console.log(`AgentHub is listening on http://${displayHost}:${PORT}`);
});

let shuttingDown = false;

async function closeStoreIfNeeded() {
  if (typeof store.close === "function") {
    await store.close();
  }
}

async function shutdown(signal) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  console.log(`Received ${signal}, shutting down AgentHub...`);

  for (const socket of appClients) {
    try {
      socket.close();
    } catch {
      // ignore socket close errors during shutdown
    }
  }

  for (const socket of agentClients.values()) {
    try {
      socket.close();
    } catch {
      // ignore socket close errors during shutdown
    }
  }

  await new Promise((resolve) => {
    server.close(() => resolve());
  });

  await closeStoreIfNeeded();
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    shutdown(signal)
      .then(() => process.exit(0))
      .catch((error) => {
        console.error("AgentHub shutdown failed:", error.message);
        process.exit(1);
      });
  });
}
