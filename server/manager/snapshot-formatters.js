import { normalizeText } from "../shared/domain-utils.js";
import { formatRelativeMinutes, isOlderThan } from "../store/state-model.js";

export function summarizeEmployee(agent, snapshot) {
  const currentTask =
    snapshot.tasks.find((task) => task.agentId === agent.id && task.active) ||
    snapshot.tasks.find((task) => task.agentId === agent.id) ||
    null;

  return {
    id: agent.id,
    name: agent.name,
    deviceId: agent.deviceId,
    deviceName: agent.deviceName,
    runtime: agent.mode,
    online: agent.online,
    lastSeenAt: agent.lastSeenAt,
    currentTaskId: currentTask?.taskId || currentTask?.id || null,
    currentTaskTitle: currentTask?.title || null,
    currentTaskStatus: currentTask?.statusLabel || (agent.online ? "空闲" : "离线"),
    currentTaskSummary: currentTask?.progressSummary || "当前没有正在推进的任务",
    conversationId: currentTask?.conversationId || null,
  };
}

export function formatEmployeeListReply(snapshot) {
  if (snapshot.agents.length === 0) {
    return "当前还没有数字员工连上来。";
  }

  const online = snapshot.agents.filter((agent) => agent.online);
  const offline = snapshot.agents.filter((agent) => !agent.online);
  const details = snapshot.agents
    .map((agent) => {
      const employee = summarizeEmployee(agent, snapshot);
      return `${employee.name}（${employee.deviceName}，${employee.online ? "在线" : "离线"}${
        employee.currentTaskTitle ? `，${employee.currentTaskStatus}：${employee.currentTaskTitle}` : ""
      }）`;
    })
    .join("；");

  return `当前有 ${online.length} 位员工在线，${offline.length} 位离线。${details}`;
}

export function formatTaskListReply(snapshot) {
  if (snapshot.tasks.length === 0) {
    return "当前还没有可汇报的任务。";
  }

  const topTasks = snapshot.tasks.slice(0, 6);
  return topTasks
    .map(
      (task) =>
        `${task.agentName}（${task.deviceName}）${task.statusLabel}：${task.title}。${task.progressSummary}`
    )
    .join("\n");
}

export function formatWorkspaceListReply(snapshot) {
  if (!Array.isArray(snapshot.workspaces) || snapshot.workspaces.length === 0) {
    return "当前还没有已登记的工作区。先让设备上的 Codex 员工带着工作区清单接入，我就能按目录和仓库帮你调度。";
  }

  return snapshot.workspaces
    .slice(0, 8)
    .map((workspace) => {
      const runtimeLabel = workspace.runtimeHints?.length
        ? `，运行时 ${workspace.runtimeHints.join(" / ")}`
        : "";
      const ownerLabel = workspace.employeeName ? `，默认员工 ${workspace.employeeName}` : "";
      return `${workspace.name}（${workspace.deviceName}，${workspace.kind}${runtimeLabel}${ownerLabel}）：${workspace.path}`;
    })
    .join("\n");
}

export function formatApprovalListReply(snapshot) {
  const pendingApprovals = (snapshot.approvals || []).filter(
    (approval) => approval.status === "pending"
  );
  if (pendingApprovals.length === 0) {
    return "当前没有等待审批的任务。";
  }

  return pendingApprovals
    .slice(0, 6)
    .map((approval) => {
      const employee = snapshot.agents.find((agent) => agent.id === approval.requestedByEmployeeId);
      const task = snapshot.tasks.find((item) => item.taskId === approval.taskId || item.id === approval.taskId);
      return `${employee?.name || approval.requestedByEmployeeId || "某位员工"} 申请审批：${
        task?.title || "未命名任务"
      }。原因：${approval.reason}`;
    })
    .join("\n");
}

export function getActiveTaskForAgent(agent, snapshot) {
  const tasks = snapshot?.tasks || [];
  return (
    tasks.find((task) => task.agentId === agent.id && task.active) ||
    tasks.find((task) => task.agentId === agent.id) ||
    null
  );
}

export function buildAttentionItems(
  snapshot,
  { staleTaskMinutes = 12 } = {}
) {
  const tasks = snapshot?.tasks || [];
  const agents = snapshot?.agents || [];
  const approvals = snapshot?.approvals || [];
  const items = [];

  approvals
    .filter((approval) => approval.status === "pending")
    .slice(0, 4)
    .forEach((approval) => {
      const task = tasks.find((item) => item.id === approval.taskId || item.taskId === approval.taskId);
      items.push({
        key: `approval-${approval.id}`,
        type: "approval",
        level: "warning",
        title: "有任务在等待审批",
        body: `${task?.title || "未命名任务"} 正在等待审批。原因：${approval.reason || "需要确认风险操作"}`,
        taskId: task?.id || approval.taskId || null,
        agentId: task?.agentId || approval.requestedByEmployeeId || null,
        approvalId: approval.id,
      });
    });

  tasks
    .filter((task) => task.blocked)
    .slice(0, 4)
    .forEach((task) => {
      items.push({
        key: `blocked-${task.id}`,
        type: "blocked_task",
        level: "danger",
        title: "有任务阻塞",
        body: `${task.agentName || "某位员工"} 在 ${task.deviceName || "当前设备"} 上处理“${
          task.title
        }”时遇到阻塞。${normalizeText(task.blockedReason || task.progressSummary)}`,
        taskId: task.id,
        agentId: task.agentId || null,
      });
    });

  tasks
    .filter((task) => task.active && isOlderThan(task.updatedAt, staleTaskMinutes) && !task.blocked)
    .slice(0, 4)
    .forEach((task) => {
      items.push({
        key: `stale-${task.id}`,
        type: "stale_task",
        level: "muted",
        title: "有任务长时间无更新",
        body: `${task.agentName || "某位员工"} 的“${task.title}”已经 ${formatRelativeMinutes(
          task.updatedAt
        )} 没有新的进展。`,
        taskId: task.id,
        agentId: task.agentId || null,
      });
    });

  agents
    .filter((agent) => !agent.online)
    .map((agent) => ({
      agent,
      task: getActiveTaskForAgent(agent, snapshot),
    }))
    .filter(({ task }) => task?.active)
    .slice(0, 4)
    .forEach(({ agent, task }) => {
      items.push({
        key: `offline-${agent.id}`,
        type: "offline_with_active_task",
        level: "danger",
        title: "有员工离线但任务未结束",
        body: `${agent.name} 在 ${agent.deviceName || "未知设备"} 上离线了，但“${
          task.title
        }”还处于 ${task.statusLabel}。`,
        taskId: task.id,
        agentId: agent.id,
      });
    });

  return items.slice(0, 8);
}
