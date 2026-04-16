import { fetchAuthenticatedSnapshot, installSnapshotRecovery } from "./live-state.js";

const APP_TOKEN_STORAGE_KEY = "agenthub-app-token-v1";
const STALE_TASK_MINUTES = 12;
const STALE_AGENT_MINUTES = 5;

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
const commanderGeneratedAt = document.querySelector("#commander-generated-at");
const commanderSummary = document.querySelector("#commander-summary");
const commanderAttention = document.querySelector("#commander-attention");
const commanderEmployees = document.querySelector("#commander-employees");
const commanderEmployeeCount = document.querySelector("#commander-employee-count");
const authModal = document.querySelector("#auth-modal");
const authModalContent = document.querySelector("#auth-modal-content");

function applySnapshot(snapshot) {
  state.auth.promptOpen = false;
  state.auth.blocked = false;
  state.auth.error = "";
  state.snapshot = snapshot || null;
}

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

  applySnapshot(result.data);
  render();
  return true;
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

function formatRelativeMinutes(value) {
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

function isOlderThan(value, minutes) {
  if (!value) {
    return false;
  }

  return Date.now() - new Date(value).getTime() > minutes * 60 * 1000;
}

function buildTaskHref(task) {
  if (!task?.id) {
    return "";
  }

  const params = new URLSearchParams();
  params.set("taskId", task.id);
  if (task.conversationId) {
    params.set("conversationId", task.conversationId);
  }
  if (task.agentId) {
    params.set("agentId", task.agentId);
  }
  if (task.agentName) {
    params.set("agentName", task.agentName);
  }
  if (task.deviceName) {
    params.set("deviceName", task.deviceName);
  }
  return `/task.html?${params.toString()}`;
}

function buildDirectHref(agent, task = null) {
  if (!agent?.id) {
    return "";
  }

  const params = new URLSearchParams();
  params.set("agentId", agent.id);
  params.set("agentName", agent.name || agent.id);
  if (agent.deviceName) {
    params.set("deviceName", agent.deviceName);
  }
  if (task?.conversationId) {
    params.set("conversationId", task.conversationId);
  }
  return `/direct.html?${params.toString()}`;
}

function buildManagerPromptHref(prompt) {
  const params = new URLSearchParams();
  params.set("prompt", prompt);
  return `/?${params.toString()}`;
}

function getActiveTaskForAgent(agent, snapshot) {
  const tasks = snapshot?.tasks || [];
  return (
    tasks.find((task) => task.agentId === agent.id && task.active) ||
    tasks.find((task) => task.agentId === agent.id) ||
    null
  );
}

function getWorkspaceLabel(agent, task, snapshot) {
  if (task?.workspaceName) {
    return task.workspaceName;
  }

  const workspaces = (snapshot?.workspaces || []).filter((item) => item.employeeId === agent.id);
  if (workspaces.length === 1) {
    return workspaces[0].name;
  }
  if (workspaces.length > 1) {
    return `${workspaces.length} 个工作区`;
  }

  return "未声明工作区";
}

function getHealthLabel(agent, task) {
  if (!agent.online) {
    return task?.active ? "离线且任务未结束" : "离线";
  }

  if (task?.blocked) {
    return "任务阻塞";
  }

  if (task?.active && isOlderThan(task.updatedAt, STALE_TASK_MINUTES)) {
    return "任务长时间无更新";
  }

  if (isOlderThan(agent.lastSeenAt, STALE_AGENT_MINUTES)) {
    return "心跳较旧";
  }

  if (task?.active) {
    return "执行中";
  }

  return "空闲";
}

function buildAttentionItems(snapshot) {
  const tasks = snapshot?.tasks || [];
  const agents = snapshot?.agents || [];
  const approvals = snapshot?.approvals || [];
  const items = [];

  approvals
    .filter((approval) => approval.status === "pending")
    .slice(0, 3)
    .forEach((approval) => {
      const task = tasks.find((item) => item.id === approval.taskId || item.taskId === approval.taskId);
      items.push({
        key: `approval-${approval.id}`,
        level: "warning",
        title: "有任务在等你拍板",
        body: `${task?.title || "未命名任务"} 正在等待审批。原因：${approval.reason || "需要确认风险操作"}`,
        primaryLabel: "查看任务",
        primaryHref: task ? buildTaskHref(task) : "/",
        secondaryLabel: "回经理处理",
        secondaryHref: buildManagerPromptHref(`帮我处理待审批任务 ${task?.title || approval.id}`),
      });
    });

  tasks
    .filter((task) => task.blocked)
    .slice(0, 3)
    .forEach((task) => {
      items.push({
        key: `blocked-${task.id}`,
        level: "danger",
        title: "有任务卡住了",
        body: `${task.agentName || "某位员工"} 在 ${task.deviceName || "当前设备"} 上处理“${
          task.title
        }”时遇到阻塞。${normalizeText(task.blockedReason || task.progressSummary)}`,
        primaryLabel: "查看任务",
        primaryHref: buildTaskHref(task),
        secondaryLabel: "去直连纠偏",
        secondaryHref: buildDirectHref(
          agents.find((agent) => agent.id === task.agentId) || {
            id: task.agentId,
            name: task.agentName,
            deviceName: task.deviceName,
          },
          task
        ),
      });
    });

  tasks
    .filter((task) => task.active && isOlderThan(task.updatedAt, STALE_TASK_MINUTES) && !task.blocked)
    .slice(0, 3)
    .forEach((task) => {
      items.push({
        key: `stale-${task.id}`,
        level: "muted",
        title: "有任务久未更新",
        body: `${task.agentName || "某位员工"} 的“${task.title}”已经 ${formatRelativeMinutes(
          task.updatedAt
        )} 没有新的进展。`,
        primaryLabel: "查看任务",
        primaryHref: buildTaskHref(task),
        secondaryLabel: "让经理跟进",
        secondaryHref: buildManagerPromptHref(
          `帮我看看 ${task.agentName || "这位员工"} 的任务 ${task.title} 为什么停下来了，给我一个简短结论`
        ),
      });
    });

  agents
    .filter((agent) => !agent.online)
    .map((agent) => ({
      agent,
      task: getActiveTaskForAgent(agent, snapshot),
    }))
    .filter(({ task }) => task?.active)
    .slice(0, 3)
    .forEach(({ agent, task }) => {
      items.push({
        key: `offline-${agent.id}`,
        level: "danger",
        title: "有员工掉线但任务还没结束",
        body: `${agent.name} 在 ${agent.deviceName || "未知设备"} 上离线了，但“${
          task.title
        }”还处于 ${task.statusLabel}。`,
        primaryLabel: "查看任务",
        primaryHref: buildTaskHref(task),
        secondaryLabel: "让经理重新评估",
        secondaryHref: buildManagerPromptHref(
          `帮我评估 ${agent.name} 当前离线的任务 ${task.title} 应该继续等、重派，还是切我去直连`
        ),
      });
    });

  return items.slice(0, 6);
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

  if (state.socket && state.socket.readyState <= 1) {
    state.socket.close();
  } else {
    connect();
  }

  refreshSnapshot();
}

function renderSummary(snapshot) {
  const summary = snapshot?.manager?.summary || {};
  commanderGeneratedAt.textContent = snapshot?.generatedAt
    ? `同步于 ${formatDateTime(snapshot.generatedAt)}`
    : "等待同步";

  commanderSummary.innerHTML = `
    <div class="manager-stat-card">
      <span class="manager-stat-label">在线员工</span>
      <strong>${summary.onlineAgentCount || 0}/${summary.totalAgentCount || 0}</strong>
    </div>
    <div class="manager-stat-card">
      <span class="manager-stat-label">执行中任务</span>
      <strong>${summary.activeTaskCount || 0}</strong>
    </div>
    <div class="manager-stat-card">
      <span class="manager-stat-label">待你确认</span>
      <strong>${summary.pendingApprovalCount || 0}</strong>
    </div>
    <div class="manager-stat-card">
      <span class="manager-stat-label">阻塞任务</span>
      <strong>${summary.blockedTaskCount || 0}</strong>
    </div>
  `;
}

function renderAttention(snapshot) {
  const items = buildAttentionItems(snapshot);
  if (items.length === 0) {
    commanderAttention.innerHTML = `
      <div class="empty-card commander-empty-card">
        当前没有需要你立刻介入的异常。你可以继续让 AI经理 帮你推进任务，或者只在需要时再进来查看。
      </div>
    `;
    return;
  }

  commanderAttention.innerHTML = items
    .map(
      (item) => `
        <article class="commander-attention-card ${escapeHtml(item.level)}">
          <div class="commander-attention-copy">
            <span class="context-eyebrow">${escapeHtml(
              item.level === "danger"
                ? "需要介入"
                : item.level === "warning"
                  ? "等待确认"
                  : "需要跟进"
            )}</span>
            <h3>${escapeHtml(item.title)}</h3>
            <p>${escapeHtml(item.body)}</p>
          </div>
          <div class="commander-card-actions">
            <a class="nav-pill secondary" href="${escapeHtml(item.primaryHref)}">${escapeHtml(
              item.primaryLabel
            )}</a>
            <a class="nav-pill" href="${escapeHtml(item.secondaryHref)}">${escapeHtml(
              item.secondaryLabel
            )}</a>
          </div>
        </article>
      `
    )
    .join("");
}

function renderEmployees(snapshot) {
  const agents = [...(snapshot?.agents || [])];
  commanderEmployeeCount.textContent = `${agents.length} 位员工`;

  if (agents.length === 0) {
    commanderEmployees.innerHTML = `
      <div class="empty-card commander-empty-card">
        当前还没有员工接进来。先让不同设备上的 Codex 员工连上 AgentHub，这里就会自动同步展示。
      </div>
    `;
    return;
  }

  const sortedAgents = agents.sort((left, right) => {
    const leftTask = getActiveTaskForAgent(left, snapshot);
    const rightTask = getActiveTaskForAgent(right, snapshot);
    const leftNeedsAttention =
      (!left.online && leftTask?.active) ||
      leftTask?.blocked ||
      (leftTask?.active && isOlderThan(leftTask.updatedAt, STALE_TASK_MINUTES));
    const rightNeedsAttention =
      (!right.online && rightTask?.active) ||
      rightTask?.blocked ||
      (rightTask?.active && isOlderThan(rightTask.updatedAt, STALE_TASK_MINUTES));

    if (leftNeedsAttention !== rightNeedsAttention) {
      return leftNeedsAttention ? -1 : 1;
    }
    if (left.online !== right.online) {
      return left.online ? -1 : 1;
    }
    return (left.name || "").localeCompare(right.name || "", "zh-CN");
  });

  commanderEmployees.innerHTML = sortedAgents
    .map((agent) => {
      const task = getActiveTaskForAgent(agent, snapshot);
      const workspaceLabel = getWorkspaceLabel(agent, task, snapshot);
      const healthLabel = getHealthLabel(agent, task);
      const statusClass =
        healthLabel.includes("阻塞") || healthLabel.includes("离线")
          ? "danger"
          : healthLabel.includes("无更新") || healthLabel.includes("较旧")
            ? "warning"
            : "ok";
      const taskHref = task ? buildTaskHref(task) : buildManagerPromptHref(`帮我看看 ${agent.name} 现在适合接什么任务`);
      const taskLabel = task ? "查看当前任务" : "让经理安排";
      const managerPrompt = task?.active
        ? `帮我看看 ${agent.name} 在 ${agent.deviceName || "这台设备"} 上当前任务 ${task.title} 的真实进度，如果停住了告诉我原因`
        : `帮我看看 ${agent.name} 现在在做什么，如果空闲就告诉我适合派给他什么`;

      return `
        <article class="commander-employee-card">
          <div class="commander-employee-head">
            <div>
              <h3>${escapeHtml(agent.name || agent.id)}</h3>
              <p class="muted">${escapeHtml(agent.runtime || "unknown")} · ${escapeHtml(
                agent.deviceName || "未命名设备"
              )}</p>
            </div>
            <span class="task-status-pill ${escapeHtml(statusClass)}">${escapeHtml(healthLabel)}</span>
          </div>

          <div class="context-grid commander-context-grid">
            <div class="context-card">
              <span class="context-eyebrow">当前任务</span>
              <strong>${escapeHtml(task?.title || "当前没有进行中的任务")}</strong>
            </div>
            <div class="context-card">
              <span class="context-eyebrow">当前工作区</span>
              <strong>${escapeHtml(workspaceLabel)}</strong>
            </div>
            <div class="context-card">
              <span class="context-eyebrow">最近同步</span>
              <strong>${escapeHtml(formatRelativeMinutes(agent.lastSeenAt || task?.updatedAt))}</strong>
            </div>
          </div>

          <div class="commander-employee-summary">
            ${escapeHtml(task?.progressSummary || agent.lastSummary || "当前没有明显异常，也没有新的进展摘要。")}
          </div>

          <div class="commander-card-actions">
            <a class="nav-pill secondary" href="${escapeHtml(taskHref)}">${escapeHtml(taskLabel)}</a>
            <a class="nav-pill secondary" href="${escapeHtml(buildDirectHref(agent, task))}">进入员工直连</a>
            <a class="nav-pill" href="${escapeHtml(buildManagerPromptHref(managerPrompt))}">让经理跟进</a>
          </div>
        </article>
      `;
    })
    .join("");
}

function renderAuthPrompt() {
  if (!state.auth.promptOpen) {
    authModal.hidden = true;
    authModalContent.innerHTML = "";
    return;
  }

  authModal.hidden = false;
  authModalContent.innerHTML = `
    <div class="session-modal-card auth-modal-card">
      <div class="session-modal-head">
        <div>
          <h3>输入访问令牌</h3>
          <p class="muted">指挥总览也需要 App Token，确认后我再继续同步员工与任务状态。</p>
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

      <div class="directory-modal-foot auth-modal-foot">
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

function render() {
  renderConnection();
  renderAuthPrompt();

  if (!state.snapshot) {
    commanderSummary.innerHTML = `
      <div class="empty-card commander-empty-card">正在同步当前 AgentHub 状态...</div>
    `;
    commanderAttention.innerHTML = "";
    commanderEmployees.innerHTML = "";
    return;
  }

  renderSummary(state.snapshot);
  renderAttention(state.snapshot);
  renderEmployees(state.snapshot);
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
    snapshotRecovery.scheduleSnapshotFallback("commander-open");
    render();
  });

  socket.addEventListener("close", () => {
    state.connected = false;
    if (state.socket === socket) {
      state.socket = null;
    }
    render();
    if (!state.auth.blocked) {
      setTimeout(connect, 1500);
      snapshotRecovery.scheduleSnapshotFallback("commander-close");
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
      applySnapshot(payload.data);
      render();
    }
  });
}

const snapshotRecovery = installSnapshotRecovery({
  connect,
  refreshSnapshot,
  isAuthBlocked: () => state.auth.blocked,
  hasSnapshot: () => Boolean(state.snapshot),
});

window.addEventListener("resize", () => {
  const viewportHeight = window.visualViewport?.height || window.innerHeight;
  document.documentElement.style.setProperty("--app-height", `${Math.round(viewportHeight)}px`);
});
window.visualViewport?.addEventListener("resize", () => {
  const viewportHeight = window.visualViewport?.height || window.innerHeight;
  document.documentElement.style.setProperty("--app-height", `${Math.round(viewportHeight)}px`);
});

document.documentElement.style.setProperty(
  "--app-height",
  `${Math.round(window.visualViewport?.height || window.innerHeight)}px`
);

connect();
refreshSnapshot();
render();
