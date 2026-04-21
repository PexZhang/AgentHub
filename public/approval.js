import { fetchAuthenticatedSnapshot, installSnapshotRecovery } from "./live-state.js";

const APP_TOKEN_STORAGE_KEY = "agenthub-app-token-v1";
const APPROVAL_STATUS_LABELS = {
  pending: "待确认",
  approved: "已通过",
  rejected: "已拒绝",
  cancelled: "已取消",
};

const route = (() => {
  const params = new URLSearchParams(window.location.search);
  return {
    approvalId: params.get("approvalId") || "",
    taskId: params.get("taskId") || "",
    conversationId: params.get("conversationId") || "",
    agentId: params.get("agentId") || "",
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
  ui: {
    pendingApprovalId: "",
    feedback: "",
    feedbackTone: "",
  },
};

const socketDot = document.querySelector("#socket-dot");
const socketText = document.querySelector("#socket-text");
const approvalShell = document.querySelector("#approval-shell");
const approvalBackLink = document.querySelector("#approval-back-link");
const approvalTitle = document.querySelector("#approval-title");
const approvalSubtitle = document.querySelector("#approval-subtitle");
const approvalBody = document.querySelector("#approval-body");
const approvalImpact = document.querySelector("#approval-impact");
const approvalNoteInput = document.querySelector("#approval-note-input");
const approvalFeedback = document.querySelector("#approval-feedback");
const approvalApproveButton = document.querySelector("#approval-approve-button");
const approvalRejectButton = document.querySelector("#approval-reject-button");
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

function approvalStatusLabel(value) {
  return APPROVAL_STATUS_LABELS[normalizeText(value)] || value || "未知";
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
  if (approvalShell) {
    approvalShell.hidden = state.auth.promptOpen;
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
          <p class="muted">确认后，我再继续加载待确认事项和影响说明。</p>
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
    approvals: [],
    tasks: [],
    agents: [],
  };
}

function findApproval(snapshot) {
  const approvals = snapshot.approvals || [];

  if (route.approvalId) {
    const byId = approvals.find((approval) => approval.id === route.approvalId);
    if (byId) {
      return byId;
    }
  }

  if (route.taskId) {
    return (
      approvals.find((approval) => approval.taskId === route.taskId && approval.status === "pending") ||
      approvals.find((approval) => approval.taskId === route.taskId) ||
      null
    );
  }

  return approvals.find((approval) => approval.status === "pending") || approvals[0] || null;
}

function findTask(snapshot, approval) {
  if (!approval?.taskId) {
    return null;
  }

  return (
    (snapshot.tasks || []).find((task) => task.id === approval.taskId) ||
    (snapshot.tasks || []).find((task) => task.taskId === approval.taskId) ||
    null
  );
}

function findAgent(snapshot, approval, task) {
  const agentId = task?.agentId || approval?.requestedByEmployeeId || route.agentId;
  if (!agentId) {
    return null;
  }

  return (snapshot.agents || []).find((agent) => agent.id === agentId) || null;
}

function buildBackHref(task, approval) {
  const params = new URLSearchParams();
  const taskId = task?.id || route.taskId || approval?.taskId || "";
  if (taskId) {
    params.set("taskId", taskId);
  }
  if (task?.conversationId || route.conversationId) {
    params.set("conversationId", task?.conversationId || route.conversationId);
  }
  if (task?.agentId || route.agentId) {
    params.set("agentId", task?.agentId || route.agentId);
  }

  return params.toString() ? `/task.html?${params.toString()}` : "/task.html";
}

function setFeedback(message = "", tone = "") {
  state.ui.feedback = message;
  state.ui.feedbackTone = tone;
}

function renderApprovalView(approval, task, agent) {
  approvalBackLink.href = buildBackHref(task, approval);

  if (!approval) {
    approvalTitle.textContent = "没有找到待确认事项";
    approvalSubtitle.textContent = "当前链接没有定位到有效审批，请返回任务页重新确认。";
    approvalBody.textContent = "这条审批可能已经处理完成，或者还没有同步到当前快照。";
    approvalImpact.textContent = "建议先回到任务页，再决定是否需要重新发起审批。";
    approvalNoteInput.value = "";
    approvalNoteInput.disabled = true;
    approvalApproveButton.disabled = true;
    approvalRejectButton.disabled = true;
    setFeedback("", "");
  } else {
    const statusText = approvalStatusLabel(approval.status);
    const agentName = agent?.name || approval.requestedByEmployeeId || "这位数字员工";
    const requestedAt = formatDateTime(approval.updatedAt || approval.createdAt);
    const pending = approval.status === "pending";

    approvalTitle.textContent = approval.requestedAction || "确认方案";
    approvalSubtitle.textContent = `${agentName} 于 ${requestedAt} 发起，当前状态：${statusText}。`;
    approvalBody.textContent = approval.reason || "当前没有额外的审批说明。";
    approvalImpact.textContent =
      approval.scope ||
      approval.resolutionNote ||
      (task?.title
        ? `这个确认会直接影响任务“${task.title}”是否继续推进。`
        : "这个确认会直接影响对应任务是否继续推进。");

    approvalNoteInput.disabled = !pending;
    approvalApproveButton.disabled = !pending || state.ui.pendingApprovalId === approval.id;
    approvalRejectButton.disabled = !pending || state.ui.pendingApprovalId === approval.id;

    if (!pending && !state.ui.feedback) {
      setFeedback(
        approval.resolutionNote
          ? `当前结果：${approval.resolutionNote}`
          : `这条审批已经处理完毕，状态为 ${statusText}。`,
        approval.status === "approved" ? "success" : approval.status === "rejected" ? "error" : ""
      );
    }
  }

  if (state.ui.feedback) {
    approvalFeedback.hidden = false;
    approvalFeedback.className = `approval-feedback ${state.ui.feedbackTone}`.trim();
    approvalFeedback.textContent = state.ui.feedback;
  } else {
    approvalFeedback.hidden = true;
    approvalFeedback.className = "approval-feedback";
    approvalFeedback.textContent = "";
  }
}

function submitDecision(decision) {
  const snapshot = getSnapshot();
  const approval = findApproval(snapshot);
  if (!approval || approval.status !== "pending" || !state.socket || state.socket.readyState !== 1) {
    return;
  }

  state.ui.pendingApprovalId = approval.id;
  setFeedback("", "");
  render();

  state.socket.send(
    JSON.stringify({
      type: "approval_decision",
      approvalId: approval.id,
      decision,
      note: normalizeText(approvalNoteInput.value),
      taskId: route.taskId || approval.taskId || "",
    })
  );
}

function render() {
  renderConnection();
  renderAuthPrompt();

  const snapshot = getSnapshot();
  const approval = findApproval(snapshot);
  const task = findTask(snapshot, approval);
  const agent = findAgent(snapshot, approval, task);

  renderApprovalView(approval, task, agent);
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
    snapshotRecovery.scheduleSnapshotFallback("approval-open");
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
      snapshotRecovery.scheduleSnapshotFallback("approval-close");
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
      return;
    }

    if (payload.type === "approval_decision_result") {
      state.ui.pendingApprovalId = "";
      setFeedback(
        payload.ok
          ? payload.message || "审批结果已提交。"
          : payload.message || "审批提交失败，请稍后重试。",
        payload.ok ? "success" : "error"
      );
      if (payload.ok) {
        refreshSnapshot();
      } else {
        render();
      }
    }
  });
}

const snapshotRecovery = installSnapshotRecovery({
  connect,
  refreshSnapshot,
  isAuthBlocked: () => state.auth.blocked,
  hasSnapshot: () => Boolean(state.snapshot?.approvals?.length),
});

approvalApproveButton?.addEventListener("click", () => submitDecision("approved"));
approvalRejectButton?.addEventListener("click", () => submitDecision("rejected"));

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
