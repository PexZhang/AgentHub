import { randomUUID } from "crypto";
import {
  buildConversationTitle,
  normalizeDeviceId,
  normalizeDeviceName,
  normalizeText,
} from "../shared/domain-utils.js";

export function buildDefaultManagerState() {
  return {
    messages: [],
    previousResponseId: null,
  };
}

export function normalizeManagerMessage(message) {
  return {
    id: normalizeText(message?.id) || randomUUID(),
    clientMessageId: normalizeText(message?.clientMessageId) || null,
    role: normalizeText(message?.role) === "assistant" ? "assistant" : "user",
    text: normalizeText(message?.text),
    createdAt: normalizeText(message?.createdAt) || new Date().toISOString(),
    status: normalizeText(message?.status) || null,
    answeredAt: normalizeText(message?.answeredAt) || null,
    failedAt: normalizeText(message?.failedAt) || null,
    errorMessage: normalizeText(message?.errorMessage) || null,
    action: message?.action || null,
  };
}

export function normalizeManagerState(input) {
  const base = buildDefaultManagerState();
  if (!input || typeof input !== "object") {
    return base;
  }

  return {
    messages: Array.isArray(input.messages)
      ? input.messages.map((message) => normalizeManagerMessage(message))
      : [],
    previousResponseId: normalizeText(input.previousResponseId) || null,
  };
}

export function truncateText(text, maxLength = 120) {
  const normalized = normalizeText(text).replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength)}…`;
}

export function formatRelativeMinutes(value) {
  if (!value) {
    return "未知";
  }

  const diffMs = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(diffMs) || diffMs < 0) {
    return "刚刚";
  }

  const diffMinutes = Math.round(diffMs / 60000);
  if (diffMinutes <= 1) {
    return "刚刚";
  }
  if (diffMinutes < 60) {
    return `${diffMinutes} 分钟前`;
  }

  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours} 小时前`;
  }

  const diffDays = Math.round(diffHours / 24);
  return `${diffDays} 天前`;
}

export function isOlderThan(value, minutes) {
  if (!value) {
    return false;
  }

  return Date.now() - new Date(value).getTime() > minutes * 60 * 1000;
}

function getLastUserMessage(messages) {
  return [...(messages || [])].reverse().find((message) => message.role === "user") || null;
}

function getLastAssistantMessage(messages) {
  return [...(messages || [])].reverse().find((message) => message.role === "assistant") || null;
}

export function buildSnapshotMessageWindow(messages, limit) {
  const sorted = [...(messages || [])].sort(
    (left, right) =>
      new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime()
  );
  const visibleMessages = sorted.slice(-limit);

  return {
    messages: visibleMessages,
    totalMessageCount: sorted.length,
    hiddenMessageCount: Math.max(0, sorted.length - visibleMessages.length),
  };
}

function deriveTaskStatus(conversation) {
  const latestUser = getLastUserMessage(conversation?.messages || []);
  if (!latestUser) {
    return {
      key: "idle",
      label: "空闲",
      active: false,
      blocked: false,
    };
  }

  if (latestUser.status === "failed") {
    return {
      key: "blocked",
      label: "已阻塞",
      active: true,
      blocked: true,
    };
  }

  if (["queued", "sent", "processing"].includes(latestUser.status)) {
    return {
      key: "active",
      label: latestUser.status === "queued" ? "待分派" : "处理中",
      active: true,
      blocked: false,
    };
  }

  return {
    key: "done",
    label: "最近完成",
    active: false,
    blocked: false,
  };
}

export function buildTaskDescriptor(conversation, agent) {
  if (!conversation) {
    return null;
  }

  const latestUser = getLastUserMessage(conversation.messages || []);
  const latestAssistant = getLastAssistantMessage(conversation.messages || []);
  const status = deriveTaskStatus(conversation);
  const lastUpdate = latestAssistant?.createdAt || latestUser?.createdAt || conversation.updatedAt;

  return {
    id: conversation.id,
    conversationId: conversation.id,
    title:
      normalizeText(conversation.title) || buildConversationTitle(latestUser?.text, "New chat"),
    agentId: conversation.agentId,
    agentName: agent?.name || conversation.agentId,
    deviceId: agent?.deviceId || conversation.deviceId || null,
    deviceName: agent?.deviceName || conversation.deviceName || "当前设备",
    status: status.key,
    statusLabel: status.label,
    active: status.active,
    blocked: status.blocked,
    lastUserText: truncateText(latestUser?.text),
    progressSummary: truncateText(
      latestAssistant?.text || latestUser?.text || "还没有任务进展"
    ),
    updatedAt: conversation.updatedAt,
    lastUpdate,
  };
}

export function buildPersistedTaskDescriptor(task, agentMap, workspaceMap, conversationMap) {
  if (!task) {
    return null;
  }

  const conversation = task.sourceConversationId
    ? conversationMap.get(task.sourceConversationId)
    : null;
  const agent = agentMap.get(task.ownerEmployeeId);
  const workspace = task.workspaceId ? workspaceMap.get(task.workspaceId) : null;
  const latestUser = conversation ? getLastUserMessage(conversation.messages || []) : null;
  const latestAssistant = conversation ? getLastAssistantMessage(conversation.messages || []) : null;

  return {
    id: task.id,
    taskId: task.id,
    conversationId: task.sourceConversationId || conversation?.id || null,
    sourceMessageId: task.sourceMessageId || null,
    title: normalizeText(task.title) || buildConversationTitle(task.goal, "新任务"),
    agentId: task.ownerEmployeeId || conversation?.agentId || null,
    agentName: agent?.name || workspace?.employeeName || task.ownerEmployeeId || "未分配员工",
    deviceId: agent?.deviceId || workspace?.deviceId || task.deviceId || null,
    deviceName:
      agent?.deviceName || workspace?.deviceName || task.deviceName || "当前设备",
    workspaceId: task.workspaceId || null,
    workspaceName: workspace?.name || null,
    status: task.status,
    statusLabel: buildTaskStatusLabel(task.status),
    active: isActiveTaskStatus(task.status),
    blocked: isBlockedTaskStatus(task.status),
    lastUserText: truncateText(task.goal || latestUser?.text),
    progressSummary: truncateText(
      task.latestSummary ||
        latestAssistant?.text ||
        latestUser?.text ||
        "还没有任务进展"
    ),
    updatedAt: task.updatedAt,
    lastUpdate: task.updatedAt,
    runStatus: task.runStatus || null,
    approvalState: task.approvalState || "not_required",
    blockedReason: task.blockedReason || null,
    outputRef: task.outputRef || null,
    managerSummary: task.managerSummary || null,
    successSignal: task.successSignal || null,
    labels: Array.isArray(task.labels) ? task.labels : [],
  };
}

export function compareByRecency(left, right) {
  return new Date(right.updatedAt || 0).getTime() - new Date(left.updatedAt || 0).getTime();
}

export function normalizeCodexSessions(input, limit = 12) {
  if (!Array.isArray(input)) {
    return [];
  }

  const seen = new Set();
  const sessions = [];

  for (const item of input) {
    const id = normalizeText(item?.id);
    if (!id || seen.has(id)) {
      continue;
    }

    seen.add(id);
    sessions.push({
      id,
      threadName:
        normalizeText(item?.threadName || item?.thread_name || item?.title) ||
        "未命名 Session",
      updatedAt:
        normalizeText(item?.updatedAt || item?.updated_at || item?.lastSeenAt) ||
        null,
    });

    if (sessions.length >= limit) {
      break;
    }
  }

  return sessions;
}

export function normalizeWorkspaceKind(value) {
  const normalized = normalizeText(value).toLowerCase();
  return normalized || "repo";
}

export function normalizeWorkspaceList(input, agentMeta = {}) {
  if (!Array.isArray(input)) {
    return [];
  }

  const seen = new Set();
  const workspaces = [];

  for (const item of input) {
    const path = normalizeText(item?.path || item?.workdir);
    if (!path) {
      continue;
    }

    const id =
      normalizeText(item?.id) ||
      `workspace-${normalizeText(agentMeta.agentId || agentMeta.id) || workspaces.length + 1}`;
    if (!id || seen.has(id)) {
      continue;
    }

    seen.add(id);
    workspaces.push({
      id,
      name: normalizeText(item?.name) || path,
      path,
      kind: normalizeWorkspaceKind(item?.kind),
      description: normalizeText(item?.description) || null,
      tags: Array.isArray(item?.tags)
        ? item.tags.map((tag) => normalizeText(tag)).filter(Boolean)
        : [],
      runtimeHints: (() => {
        const hints = Array.isArray(item?.runtimeHints)
          ? item.runtimeHints.map((hint) => normalizeText(hint)).filter(Boolean)
          : [];
        if (hints.length > 0) {
          return hints;
        }
        return agentMeta.mode ? [agentMeta.mode] : [];
      })(),
      deviceId: normalizeDeviceId(item?.deviceId || agentMeta.deviceId),
      deviceName: normalizeDeviceName(item?.deviceName || agentMeta.deviceName),
      employeeId: normalizeText(
        item?.defaultEmployeeId || item?.employeeId || agentMeta.agentId || agentMeta.id
      ),
      employeeName: normalizeText(item?.employeeName || agentMeta.name) || null,
      online: Boolean(agentMeta.online ?? true),
      updatedAt: new Date().toISOString(),
    });
  }

  return workspaces;
}

export function normalizeTaskPriority(value) {
  const normalized = normalizeText(value).toLowerCase();
  return ["low", "normal", "high", "urgent"].includes(normalized) ? normalized : "normal";
}

export function normalizeTaskStatus(value, fallback = "queued") {
  const normalized = normalizeText(value).toLowerCase();
  return [
    "draft",
    "queued",
    "assigned",
    "in_progress",
    "waiting_approval",
    "blocked",
    "handoff_pending",
    "completed",
    "failed",
    "cancelled",
  ].includes(normalized)
    ? normalized
    : fallback;
}

export function normalizeRunStatus(value) {
  const normalized = normalizeText(value).toLowerCase();
  return [
    "queued",
    "accepted",
    "starting",
    "running",
    "waiting_approval",
    "blocked",
    "handoff_pending",
    "completed",
    "failed",
    "cancelled",
  ].includes(normalized)
    ? normalized
    : null;
}

export function mapRunStatusToTaskStatus(runStatus) {
  const normalized = normalizeRunStatus(runStatus);
  if (!normalized) {
    return null;
  }

  if (normalized === "queued") {
    return "queued";
  }

  if (["accepted", "starting"].includes(normalized)) {
    return "assigned";
  }

  if (normalized === "running") {
    return "in_progress";
  }

  if (normalized === "waiting_approval") {
    return "waiting_approval";
  }

  if (normalized === "blocked") {
    return "blocked";
  }

  if (normalized === "handoff_pending") {
    return "handoff_pending";
  }

  if (normalized === "completed") {
    return "completed";
  }

  if (normalized === "failed") {
    return "failed";
  }

  if (normalized === "cancelled") {
    return "cancelled";
  }

  return null;
}

export function isActiveTaskStatus(status) {
  return [
    "queued",
    "assigned",
    "in_progress",
    "waiting_approval",
    "blocked",
    "handoff_pending",
  ].includes(normalizeTaskStatus(status, "queued"));
}

export function isBlockedTaskStatus(status) {
  return ["waiting_approval", "blocked", "handoff_pending"].includes(
    normalizeTaskStatus(status, "queued")
  );
}

export function buildTaskStatusLabel(status) {
  const normalized = normalizeTaskStatus(status, "queued");
  return (
    {
      draft: "待确认",
      queued: "待分派",
      assigned: "已分派",
      in_progress: "处理中",
      waiting_approval: "等待审批",
      blocked: "已阻塞",
      handoff_pending: "待交接",
      completed: "已完成",
      failed: "失败",
      cancelled: "已取消",
    }[normalized] || "未知状态"
  );
}

export function normalizeStoredWorkspaceRecord(workspace, index = 0) {
  const path = normalizeText(workspace?.path || workspace?.workdir);
  const id =
    normalizeText(workspace?.id) ||
    (path ? `workspace-${normalizeText(path).toLowerCase().replace(/[^a-z0-9]+/g, "-")}` : "") ||
    `workspace-${index + 1}`;

  return {
    id,
    name: normalizeText(workspace?.name) || path || `Workspace ${index + 1}`,
    path: path || null,
    kind: normalizeWorkspaceKind(workspace?.kind),
    description: normalizeText(workspace?.description) || null,
    tags: Array.isArray(workspace?.tags)
      ? workspace.tags.map((tag) => normalizeText(tag)).filter(Boolean)
      : [],
    runtimeHints: Array.isArray(workspace?.runtimeHints)
      ? workspace.runtimeHints.map((hint) => normalizeText(hint)).filter(Boolean)
      : [],
    deviceId: normalizeDeviceId(workspace?.deviceId),
    deviceName: normalizeDeviceName(workspace?.deviceName),
    employeeId: normalizeText(workspace?.employeeId || workspace?.defaultEmployeeId) || null,
    employeeName: normalizeText(workspace?.employeeName) || null,
    online: Boolean(workspace?.online),
    updatedAt: normalizeText(workspace?.updatedAt) || new Date().toISOString(),
  };
}

export function normalizeStoredTaskRecord(task) {
  const status = normalizeTaskStatus(task?.status, "queued");
  const runStatus =
    normalizeRunStatus(task?.runStatus) ||
    normalizeRunStatus(task?.status) ||
    (status === "completed"
      ? "completed"
      : status === "failed"
        ? "failed"
        : status === "blocked"
          ? "blocked"
          : status === "waiting_approval"
            ? "waiting_approval"
            : status === "handoff_pending"
              ? "handoff_pending"
              : status === "in_progress"
                ? "running"
                : status === "assigned"
                  ? "accepted"
                  : status === "queued"
                    ? "queued"
                    : null);
  const createdAt = normalizeText(task?.createdAt) || new Date().toISOString();

  return {
    id: normalizeText(task?.id) || randomUUID(),
    title:
      normalizeText(task?.title) ||
      buildConversationTitle(task?.goal || task?.latestSummary, "新任务"),
    goal: normalizeText(task?.goal) || "",
    status,
    priority: normalizeTaskPriority(task?.priority),
    workspaceId: normalizeText(task?.workspaceId) || null,
    ownerEmployeeId: normalizeText(task?.ownerEmployeeId || task?.agentId) || null,
    requestedBy: normalizeText(task?.requestedBy) || "human",
    sourceConversationId:
      normalizeText(task?.sourceConversationId || task?.conversationId) || null,
    sourceMessageId: normalizeText(task?.sourceMessageId || task?.replyTo) || null,
    directConversationId: normalizeText(task?.directConversationId) || null,
    createdAt,
    updatedAt: normalizeText(task?.updatedAt) || createdAt,
    latestSummary:
      normalizeText(task?.latestSummary || task?.progressSummary || task?.lastUserText) || "",
    blockedReason: normalizeText(task?.blockedReason || task?.errorMessage) || null,
    approvalState: normalizeText(task?.approvalState) || "not_required",
    approvalReason: normalizeText(task?.approvalReason) || null,
    outputRef: normalizeText(task?.outputRef) || null,
    managerSummary: normalizeText(task?.managerSummary) || null,
    successSignal: normalizeText(task?.successSignal) || null,
    labels: Array.isArray(task?.labels)
      ? task.labels.map((item) => normalizeText(item)).filter(Boolean)
      : [],
    candidateWorkspaceIds: Array.isArray(task?.candidateWorkspaceIds)
      ? task.candidateWorkspaceIds.map((id) => normalizeText(id)).filter(Boolean)
      : [],
    deviceId: normalizeText(task?.deviceId) || null,
    deviceName: normalizeText(task?.deviceName) || null,
    runId: normalizeText(task?.runId) || null,
    runStatus,
  };
}

export function normalizeStoredEmployeeRecord(employee) {
  const updatedAt = normalizeText(employee?.updatedAt) || new Date().toISOString();
  return {
    id: normalizeText(employee?.id || employee?.employeeId) || randomUUID(),
    name: normalizeText(employee?.name || employee?.employeeName) || "Digital Employee",
    deviceId: normalizeDeviceId(employee?.deviceId),
    deviceName: normalizeDeviceName(employee?.deviceName),
    runtime: normalizeText(employee?.runtime || employee?.mode) || "unknown",
    version: normalizeText(employee?.version) || null,
    capabilities: Array.isArray(employee?.capabilities)
      ? employee.capabilities.map((value) => normalizeText(value)).filter(Boolean)
      : [],
    status: normalizeText(employee?.status) || "idle",
    online: Boolean(employee?.online),
    currentTaskId: normalizeText(employee?.currentTaskId) || null,
    currentRunId: normalizeText(employee?.currentRunId) || null,
    lastSummary: normalizeText(employee?.lastSummary) || null,
    health: normalizeText(employee?.health) || null,
    labels: Array.isArray(employee?.labels)
      ? employee.labels.map((value) => normalizeText(value)).filter(Boolean)
      : [],
    lastSeenAt: normalizeText(employee?.lastSeenAt) || updatedAt,
    updatedAt,
  };
}

function normalizeApprovalStatus(value) {
  const normalized = normalizeText(value).toLowerCase();
  return ["pending", "approved", "rejected", "cancelled"].includes(normalized)
    ? normalized
    : "pending";
}

export function normalizeApprovalRecord(approval) {
  const createdAt = normalizeText(approval?.createdAt) || new Date().toISOString();
  return {
    id: normalizeText(approval?.id) || randomUUID(),
    taskId: normalizeText(approval?.taskId) || null,
    runId: normalizeText(approval?.runId) || null,
    requestedByEmployeeId:
      normalizeText(approval?.requestedByEmployeeId || approval?.employeeId) || null,
    reason: normalizeText(approval?.reason) || "需要审批",
    scope: normalizeText(approval?.scope) || null,
    requestedAction: normalizeText(approval?.requestedAction) || null,
    riskLevel: normalizeText(approval?.riskLevel) || "medium",
    status: normalizeApprovalStatus(approval?.status),
    grantedBy: normalizeText(approval?.grantedBy) || null,
    grantedAt: normalizeText(approval?.grantedAt) || null,
    rejectedAt: normalizeText(approval?.rejectedAt) || null,
    resolutionNote: normalizeText(approval?.resolutionNote) || null,
    createdAt,
    updatedAt: normalizeText(approval?.updatedAt) || createdAt,
  };
}

export function inferAgentModeFromConversations(conversations) {
  if (!Array.isArray(conversations) || conversations.length === 0) {
    return "offline";
  }

  const hasCodexContext = conversations.some(
    (conversation) => conversation.codexSessionId || conversation.codexWorkdir
  );

  return hasCodexContext ? "codex" : "offline";
}

export function buildDefaultStoreState() {
  return {
    conversations: [],
    employees: [],
    workspaces: [],
    tasks: [],
    approvals: [],
    manager: buildDefaultManagerState(),
  };
}

export function normalizePersistedStoreState(parsed) {
  if (!parsed || !Array.isArray(parsed.conversations)) {
    return null;
  }

  return {
    conversations: parsed.conversations,
    employees: Array.isArray(parsed.employees)
      ? parsed.employees.map((employee) => normalizeStoredEmployeeRecord(employee)).filter(Boolean)
      : [],
    workspaces: Array.isArray(parsed.workspaces)
      ? parsed.workspaces
          .map((workspace, index) => normalizeStoredWorkspaceRecord(workspace, index))
          .filter(Boolean)
      : [],
    tasks: Array.isArray(parsed.tasks)
      ? parsed.tasks.map((task) => normalizeStoredTaskRecord(task)).filter(Boolean)
      : [],
    approvals: Array.isArray(parsed.approvals)
      ? parsed.approvals.map((approval) => normalizeApprovalRecord(approval)).filter(Boolean)
      : [],
    manager: normalizeManagerState(parsed.manager),
  };
}
