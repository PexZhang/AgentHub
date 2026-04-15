function normalizeText(value) {
  return String(value || "").trim();
}

function unique(items) {
  return [...new Set(items.filter(Boolean))];
}

function buildFallbackTitle(goal) {
  const compact = normalizeText(goal).replace(/\s+/g, " ");
  if (!compact) {
    return "新任务";
  }

  const firstSegment = compact.split(/[，。；;\n]/)[0].trim() || compact;
  return firstSegment.length > 28 ? `${firstSegment.slice(0, 28)}…` : firstSegment;
}

function inferSuccessSignal(goal, workspace) {
  const normalizedGoal = normalizeText(goal);
  const workspaceKind = normalizeText(workspace?.kind).toLowerCase();

  if (workspaceKind === "docs") {
    return `完成后请回报整理结果、输出位置，以及“${normalizedGoal || "目标"}”是否已经落地。`;
  }

  if (workspaceKind === "logs") {
    return `完成后请给出结论、关键信号和下一步建议，并明确“${normalizedGoal || "目标"}”是否已完成。`;
  }

  return `完成后请明确汇报结果、关键改动和下一步建议，并确认“${normalizedGoal || "目标"}”是否完成。`;
}

function buildManagerSummary({
  goal,
  employee,
  workspace,
  autoSelectedWorkspace = false,
  assumedFromSingleWorkspace = false,
}) {
  const employeeName = normalizeText(employee?.name) || "某位员工";
  const deviceName = normalizeText(employee?.deviceName);
  const workspaceName = normalizeText(workspace?.name);
  const workspacePath = normalizeText(workspace?.path);
  const locationLabel = deviceName ? `${employeeName}（${deviceName}）` : employeeName;

  if (workspaceName) {
    const selectionNote = assumedFromSingleWorkspace
      ? "我没有拿到明确工作区名，所以先按这位员工唯一的工作区处理。"
      : autoSelectedWorkspace
        ? "我已经自动绑定了这位员工的默认工作区。"
        : "我已经绑定了明确工作区。";
    return `${selectionNote} 当前由 ${locationLabel} 在 ${workspaceName}${
      workspacePath ? `（${workspacePath}）` : ""
    } 推进：${normalizeText(goal)}。`;
  }

  return `当前由 ${locationLabel} 推进：${normalizeText(goal)}。`;
}

export function buildManagerTaskDraft({
  goal,
  employee = null,
  workspace = null,
  autoSelectedWorkspace = false,
  assumedFromSingleWorkspace = false,
  taskTitle = "",
  successSignal = "",
  requestedBy = "manager",
} = {}) {
  const normalizedGoal = normalizeText(goal);
  const title = normalizeText(taskTitle) || buildFallbackTitle(normalizedGoal);
  const effectiveSuccessSignal =
    normalizeText(successSignal) || inferSuccessSignal(normalizedGoal, workspace);

  const labels = unique([
    "manager-assigned",
    normalizeText(workspace?.kind),
    normalizeText(employee?.runtime || employee?.mode),
  ]);

  return {
    title,
    goal: normalizedGoal,
    requestedBy: normalizeText(requestedBy) || "manager",
    managerSummary: buildManagerSummary({
      goal: normalizedGoal,
      employee,
      workspace,
      autoSelectedWorkspace,
      assumedFromSingleWorkspace,
    }),
    successSignal: effectiveSuccessSignal,
    labels,
  };
}
