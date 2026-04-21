import { fetchAuthenticatedSnapshot, installSnapshotRecovery } from "./live-state.js";

const APP_TOKEN_STORAGE_KEY = "agenthub-app-token-v1";
const TASK_APPROVAL_LABELS = {
  not_required: "无需审批",
  pending: "等待审批",
  approved: "已批准",
  rejected: "已拒绝",
};

const route = (() => {
  const params = new URLSearchParams(window.location.search);
  return {
    taskId: params.get("taskId") || "",
    conversationId: params.get("conversationId") || "",
    agentId: params.get("agentId") || "",
    agentName: params.get("agentName") || "",
    deviceName: params.get("deviceName") || "",
  };
})();

const state = {
  connected: false,
  socket: null,
  snapshot: null,
  auth: {
    token: loadStoredAppToken(),
    input: "",
    promptOpen: false,
    blocked: false,
    error: "",
  },
};

const socketDot = document.querySelector("#socket-dot");
const socketText = document.querySelector("#socket-text");
const taskShell = document.querySelector("#task-shell");
const taskPageSubtitle = document.querySelector("#task-page-subtitle");
const taskTitle = document.querySelector("#task-title");
const taskSubtitle = document.querySelector("#task-subtitle");
const taskStatusBadges = document.querySelector("#task-status-badges");
const taskGoal = document.querySelector("#task-goal");
const taskProgress = document.querySelector("#task-progress");
const taskContextGrid = document.querySelector("#task-context-grid");
const taskApprovalList = document.querySelector("#task-approval-list");
const authModal = document.querySelector("#auth-modal");
const authModalContent = document.querySelector("#auth-modal-content");

function loadStoredAppToken() {
  try {
    return window.localStorage.getItem(APP_TOKEN_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

function persistStoredAppToken(token) {
  try {
    if (token) {
      window.localStorage.setItem(APP_TOKEN_STORAGE_KEY, token);
      return;
    }

    window.localStorage.removeItem(APP_TOKEN_STORAGE_KEY);
  } catch {
    // Ignore storage write failures.
  }
}

function normalizeText(value) {
  return String(value || "").trim();
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatDateTime(value) {
  if (!value) {
    return "--";
  }

  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function approvalStateLabel(value) {
  return TASK_APPROVAL_LABELS[normalizeText(value)] || value || "未知";
}

function updateViewportHeight() {
  const viewportHeight = window.visualViewport?.height || window.innerHeight;
  document.documentElement.style.setProperty("--app-height", `${Math.round(viewportHeight)}px`);
}

function renderConnection() {
  socketDot?.classList.toggle("online", state.connected);
  if (socketText) {
    socketText.textContent = state.connected
      ? "Hub已连接"
      : state.auth.promptOpen
        ? "等待令牌"
        : "连接中断";
  }
}

function openAuthPrompt(message = "") {
  state.auth.promptOpen = true;
  state.auth.blocked = true;
  state.auth.error = message || state.auth.error || "请输入访问令牌以连接这个 AgentHub。";
  state.auth.input = "";
  renderAuthPrompt();
}

function clearAuthToken() {
  state.auth.token = "";
  state.auth.input = "";
  state.auth.error = "";
  state.auth.blocked = true;
  persistStoredAppToken("");
}

function submitAuthToken(rawToken) {
  const token = normalizeText(rawToken);
  if (!token) {
    state.auth.error = "请输入访问令牌。";
    renderAuthPrompt();
    return;
  }

  state.auth.token = token;
  state.auth.input = "";
  state.auth.error = "";
  state.auth.promptOpen = false;
  state.auth.blocked = false;
  persistStoredAppToken(token);

  const existingSocket = state.socket;
  state.socket = null;
  state.connected = false;
  if (existingSocket && existingSocket.readyState <= 1) {
    existingSocket.close();
  }

  connect();
  refreshSnapshot();
}

async function refreshSnapshot() {
  if (state.auth.blocked) {
    return false;
  }

  const result = await fetchAuthenticatedSnapshot(state.auth.token || "");
  if (result.authRequired) {
    state.connected = false;
    clearAuthToken();
    openAuthPrompt(result.message || "访问令牌无效，请重新输入。");
    render();
    return false;
  }

  if (!result.ok) {
    return false;
  }

  state.snapshot = result.data || null;
  state.auth.promptOpen = false;
  state.auth.blocked = false;
  state.auth.error = "";
  render();
  return true;
}

function renderAuthPrompt() {
  if (taskShell) {
    taskShell.hidden = state.auth.promptOpen;
  }

  if (!state.auth.promptOpen) {
    authModal.hidden = true;
    authModalContent.innerHTML = "";
    return;
  }

  authModal.hidden = false;
  authModalContent.innerHTML = `
    <div class="auth-entry-card">
      <div class="hero-copy compact">
        <div class="brand-lockup" aria-label="AgentHub">
          <img class="brand-mark" src="/assets/agenthub-logo-a-triad.svg" alt="" />
          <span class="brand-wordmark">AgentHub</span>
        </div>
        <div>
          <h3>先验证访问令牌</h3>
          <p class="muted">确认后，我再继续加载任务状态、最近进展和下一步动作。</p>
        </div>
      </div>

      <label class="directory-field">
        <span>访问令牌</span>
        <input
          id="auth-token-input"
          type="password"
          value="${escapeHtml(state.auth.input)}"
          placeholder="请输入 APP_TOKEN"
          autocomplete="current-password"
        />
      </label>

      ${
        state.auth.error
          ? `<div class="auth-error">${escapeHtml(state.auth.error)}</div>`
          : ""
      }

      <div class="auth-entry-foot">
        <button type="button" class="directory-secondary-button" id="auth-clear-button">
          清空本地令牌
        </button>
        <button type="button" class="directory-primary-button" id="auth-submit-button">
          连接 AgentHub
        </button>
      </div>
    </div>
  `;

  const input = authModalContent.querySelector("#auth-token-input");
  input?.addEventListener("input", (event) => {
    state.auth.input = event.target.value;
  });
  input?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      submitAuthToken(state.auth.input);
    }
  });
  input?.focus();

  authModalContent
    .querySelector("#auth-clear-button")
    ?.addEventListener("click", () => {
      clearAuthToken();
      renderAuthPrompt();
    });

  authModalContent
    .querySelector("#auth-submit-button")
    ?.addEventListener("click", () => submitAuthToken(state.auth.input));
}

function getSnapshot() {
  return state.snapshot || {
    tasks: [],
    approvals: [],
    conversations: [],
    agents: [],
    workspaces: [],
  };
}

function findTask(snapshot) {
  const tasks = snapshot.tasks || [];

  if (route.taskId) {
    const byTaskId =
      tasks.find((task) => task.id === route.taskId) ||
      tasks.find((task) => task.taskId === route.taskId);
    if (byTaskId) {
      return byTaskId;
    }
  }

  if (route.conversationId) {
    const byConversationId = tasks.find((task) => task.conversationId === route.conversationId);
    if (byConversationId) {
      return byConversationId;
    }
  }

  if (route.agentId) {
    return (
      tasks.find((task) => task.agentId === route.agentId && task.active) ||
      tasks.find((task) => task.agentId === route.agentId) ||
      null
    );
  }

  return null;
}

function findConversation(snapshot, task) {
  const conversationId = task?.conversationId || route.conversationId;
  if (!conversationId) {
    return null;
  }

  return (snapshot.conversations || []).find((item) => item.id === conversationId) || null;
}

function findAgent(snapshot, task) {
  const agentId = task?.agentId || route.agentId;
  if (!agentId) {
    return null;
  }

  return (snapshot.agents || []).find((item) => item.id === agentId) || null;
}

function findWorkspace(snapshot, task) {
  if (!task?.workspaceId) {
    return null;
  }

  return (snapshot.workspaces || []).find((item) => item.id === task.workspaceId) || null;
}

function listApprovals(snapshot, task) {
  if (!task?.id) {
    return [];
  }

  return (snapshot.approvals || [])
    .filter((approval) => approval.taskId === task.id)
    .sort((left, right) => new Date(right.updatedAt || 0) - new Date(left.updatedAt || 0));
}

function buildDirectHref(task, conversation, agent, deviceName) {
  if (!task?.agentId && !route.agentId) {
    return "";
  }

  const params = new URLSearchParams();
  params.set("agentId", task?.agentId || route.agentId);
  if (conversation?.id || task?.conversationId || route.conversationId) {
    params.set("conversationId", conversation?.id || task?.conversationId || route.conversationId);
  }
  if (agent?.name || task?.agentName || route.agentName) {
    params.set("agentName", agent?.name || task?.agentName || route.agentName);
  }
  if (deviceName) {
    params.set("deviceName", deviceName);
  }

  return `/direct.html?${params.toString()}`;
}

function buildEmployeeHref(task, conversation, agent, deviceName) {
  if (!task?.agentId && !route.agentId) {
    return "";
  }

  const params = new URLSearchParams();
  params.set("agentId", task?.agentId || route.agentId);
  if (conversation?.id || task?.conversationId || route.conversationId) {
    params.set("conversationId", conversation?.id || task?.conversationId || route.conversationId);
  }
  if (agent?.name || task?.agentName || route.agentName) {
    params.set("agentName", agent?.name || task?.agentName || route.agentName);
  }
  if (deviceName) {
    params.set("deviceName", deviceName);
  }

  return `/employee.html?${params.toString()}`;
}

function buildApprovalHref(task, approval) {
  if (!approval?.id) {
    return "";
  }

  const params = new URLSearchParams();
  params.set("approvalId", approval.id);
  if (task?.id) {
    params.set("taskId", task.id);
  }
  if (task?.conversationId || route.conversationId) {
    params.set("conversationId", task?.conversationId || route.conversationId);
  }
  if (task?.agentId || route.agentId) {
    params.set("agentId", task?.agentId || route.agentId);
  }

  return `/approval.html?${params.toString()}`;
}

function renderStatusBadges(task, agent, workspace) {
  const badges = [
    {
      tone: task?.blocked ? "blocked" : task?.active ? "active" : "idle",
      label: task?.statusLabel || task?.status || "未命名状态",
    },
    {
      tone: normalizeText(task?.approvalState) === "pending" ? "warning" : "idle",
      label: approvalStateLabel(task?.approvalState),
    },
  ];

  if (agent?.name || task?.agentName || route.agentName) {
    badges.push({
      tone: "idle",
      label: `员工 ${agent?.name || task?.agentName || route.agentName}`,
    });
  }

  if (workspace?.name || task?.workspaceName) {
    badges.push({
      tone: "idle",
      label: `工作区 ${workspace?.name || task?.workspaceName}`,
    });
  }

  return badges
    .map(
      (item) =>
        `<span class="task-status-pill ${escapeHtml(item.tone)}">${escapeHtml(item.label)}</span>`
    )
    .join("");
}

function renderActionCard(task, conversation, agent, workspace, approvals) {
  const approval = approvals.find((item) => item.status === "pending") || approvals[0] || null;
  const agentName = agent?.name || task?.agentName || route.agentName || "这位员工";
  const deviceName = agent?.deviceName || task?.deviceName || route.deviceName || "当前设备";
  const directHref = buildDirectHref(task, conversation, agent, deviceName);
  const employeeHref = buildEmployeeHref(task, conversation, agent, deviceName);

  if (!task) {
    return `
      <article class="task-jump-card">
        <div class="task-jump-copy">
          <strong>回到 AI经理</strong>
          <p>当前没有找到这条任务，建议回到经理页重新定位目标。</p>
        </div>
        <div class="actions">
          <a class="ghost-btn" href="/">返回首页</a>
        </div>
      </article>
    `;
  }

  if (approval) {
    const approvalHref = buildApprovalHref(task, approval);
    return `
      <article class="task-jump-card">
        <div class="task-jump-copy">
          <strong>去审批确认</strong>
          <p>${escapeHtml(
            approval.reason || `${agentName} 当前需要你拍板，确认后任务就能继续推进。`
          )}</p>
        </div>
        <div class="actions">
          ${
            directHref
              ? `<a class="ghost-btn" href="${escapeHtml(directHref)}">去聊天</a>`
              : ""
          }
          ${
            approvalHref
              ? `<a class="primary-btn" href="${escapeHtml(approvalHref)}">审批</a>`
              : ""
          }
        </div>
      </article>
    `;
  }

  return `
    <article class="task-jump-card">
      <div class="task-jump-copy">
        <strong>继续和 ${escapeHtml(agentName)} 沟通</strong>
        <p>${escapeHtml(
          workspace?.name
            ? `工作区 ${workspace.name} 已经绑定好了，下一步更适合直接去员工聊天页推进。`
            : `${agentName} 当前没有待审批项，可以直接进入聊天继续推进。`
        )}</p>
      </div>
      <div class="actions">
        ${
          employeeHref
            ? `<a class="ghost-btn" href="${escapeHtml(employeeHref)}">查看员工</a>`
            : ""
        }
        ${
          directHref
            ? `<a class="primary-btn" href="${escapeHtml(directHref)}">去聊天</a>`
            : ""
        }
      </div>
    </article>
  `;
}

function renderTaskView(task, conversation, agent, workspace, approvals) {
  if (!task) {
    taskPageSubtitle.textContent = "当前链接没有找到对应任务。";
    taskTitle.textContent = "没有找到这条任务";
    taskSubtitle.textContent = route.taskId
      ? `任务 ${route.taskId} 目前不在快照里，可能已经被删除或还未同步。`
      : "当前没有可展示的任务。";
    taskGoal.textContent = "请返回 AI 经理，让我重新定位你要查看的任务。";
    taskProgress.textContent = "任务详情为空时，不建议直接跳员工直连，以免打断错误对象。";
    taskStatusBadges.innerHTML = "";
    taskContextGrid.innerHTML = "";
    taskApprovalList.innerHTML = renderActionCard(null, null, null, null, []);
    return;
  }

  const resolvedAgentName = agent?.name || task.agentName || route.agentName || "未分配员工";
  const resolvedDeviceName =
    agent?.deviceName || task.deviceName || route.deviceName || "未识别设备";
  const workspaceName = workspace?.name || task.workspaceName || "未绑定工作区";
  const lastUpdate = formatDateTime(task.updatedAt || task.lastUpdate);
  const latestConversationLine =
    conversation?.messages?.length > 0
      ? conversation.messages[conversation.messages.length - 1]?.text || ""
      : "";

  taskPageSubtitle.textContent = `${resolvedAgentName} · ${resolvedDeviceName}`;
  taskTitle.textContent = task.title || "未命名任务";
  taskSubtitle.textContent = `任务最后更新于 ${lastUpdate}，先看清状态，再决定是审批还是继续沟通。`;
  taskGoal.textContent = task.lastUserText || task.title || "暂无任务目标";
  taskProgress.textContent =
    task.progressSummary ||
    latestConversationLine ||
    "这条任务目前还没有新的进展说明。";
  taskStatusBadges.innerHTML = renderStatusBadges(task, agent, workspace);

  const contextItems = [
    ["负责人", resolvedAgentName],
    ["所在设备", resolvedDeviceName],
    ["工作区", workspaceName],
    ["任务状态", task.statusLabel || task.status || "未知"],
    ["审批状态", approvalStateLabel(task.approvalState)],
    ["最近更新", lastUpdate],
  ];

  if (task.outputRef) {
    contextItems.push(["输出引用", task.outputRef]);
  }

  if (task.blockedReason) {
    contextItems.push(["阻塞原因", task.blockedReason]);
  }

  taskContextGrid.innerHTML = contextItems
    .map(
      ([label, value]) => `
        <div class="context-item">
          <span class="context-label">${escapeHtml(label)}</span>
          <span class="context-value">${escapeHtml(value || "--")}</span>
        </div>
      `
    )
    .join("");

  taskApprovalList.innerHTML = renderActionCard(task, conversation, agent, workspace, approvals);
}

function render() {
  renderConnection();
  renderAuthPrompt();

  const snapshot = getSnapshot();
  const task = findTask(snapshot);
  const conversation = findConversation(snapshot, task);
  const agent = findAgent(snapshot, task);
  const workspace = findWorkspace(snapshot, task);
  const approvals = listApprovals(snapshot, task);

  renderTaskView(task, conversation, agent, workspace, approvals);
}

function connect() {
  if (state.auth.blocked) {
    return;
  }

  if (state.socket && state.socket.readyState <= 1) {
    return;
  }

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${protocol}//${window.location.host}/ws`);
  state.socket = socket;

  socket.addEventListener("open", () => {
    state.connected = true;
    socket.send(
      JSON.stringify({
        type: "hello",
        role: "app",
        token: state.auth.token || "",
        appOrigin: window.location.origin,
      })
    );
    snapshotRecovery.scheduleSnapshotFallback("task-open");
    render();
  });

  socket.addEventListener("close", () => {
    state.connected = false;
    if (state.socket === socket) {
      state.socket = null;
    }
    render();
    if (!state.auth.blocked) {
      window.setTimeout(connect, 1500);
      snapshotRecovery.scheduleSnapshotFallback("task-close");
    }
  });

  socket.addEventListener("message", (event) => {
    const payload = JSON.parse(event.data);

    if (payload.type === "auth_required") {
      state.connected = false;
      clearAuthToken();
      openAuthPrompt(payload.message || "访问令牌无效，请重新输入。");
      if (socket.readyState <= 1) {
        socket.close();
      }
      return;
    }

    if (payload.type === "snapshot") {
      snapshotRecovery.clearSnapshotFallback();
      state.snapshot = payload.data || null;
      render();
    }
  });
}

const snapshotRecovery = installSnapshotRecovery({
  connect,
  refreshSnapshot,
  isAuthBlocked: () => state.auth.blocked,
  hasSnapshot: () => Boolean(state.snapshot?.tasks?.length || state.snapshot?.approvals?.length),
});

function handleViewportChange() {
  updateViewportHeight();
}

window.addEventListener("resize", handleViewportChange);
window.visualViewport?.addEventListener("resize", handleViewportChange);
window.visualViewport?.addEventListener("scroll", handleViewportChange);

updateViewportHeight();
connect();
refreshSnapshot();
render();
