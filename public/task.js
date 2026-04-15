const APP_TOKEN_STORAGE_KEY = "agenthub-app-token-v1";
const STATUS_LABELS = {
  queued: "排队中",
  sent: "已发送",
  processing: "处理中",
  answered: "已完成",
  failed: "失败",
};
const TASK_APPROVAL_LABELS = {
  not_required: "无需审批",
  pending: "等待审批",
  approved: "已批准",
  rejected: "已拒绝",
};
const APPROVAL_STATUS_LABELS = {
  pending: "待确认",
  approved: "已通过",
  rejected: "已拒绝",
  cancelled: "已取消",
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
  ui: {
    shouldStickToBottom: true,
    pendingAutoScroll: true,
    approvalPendingId: "",
    approvalErrors: {},
    approvalNotes: {},
    lastConversationRenderSignature: "",
  },
};

const socketDot = document.querySelector("#socket-dot");
const socketText = document.querySelector("#socket-text");
const taskPageSubtitle = document.querySelector("#task-page-subtitle");
const taskTitle = document.querySelector("#task-title");
const taskSubtitle = document.querySelector("#task-subtitle");
const taskStatusBadges = document.querySelector("#task-status-badges");
const taskGoal = document.querySelector("#task-goal");
const taskProgress = document.querySelector("#task-progress");
const taskContextGrid = document.querySelector("#task-context-grid");
const taskApprovalList = document.querySelector("#task-approval-list");
const taskDirectLink = document.querySelector("#task-direct-link");
const taskConversationTitle = document.querySelector("#task-conversation-title");
const taskConversationSubtitle = document.querySelector("#task-conversation-subtitle");
const taskMessagesNode = document.querySelector("#task-messages");
const taskMessageToolbar = document.querySelector("#task-message-toolbar");
const taskMessageJumpButton = document.querySelector("#task-message-jump-button");
const authModal = document.querySelector("#auth-modal");
const authModalContent = document.querySelector("#auth-modal-content");
let taskScrollBound = false;

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

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatTime(value) {
  if (!value) {
    return "--";
  }

  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
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

function normalizeText(value) {
  return String(value || "").trim();
}

function isNearBottom(node, threshold = 40) {
  if (!node) {
    return true;
  }

  const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
  return distance <= threshold;
}

function updateJumpButton() {
  if (!taskMessagesNode || !taskMessageJumpButton) {
    return;
  }

  taskMessageJumpButton.hidden = isNearBottom(taskMessagesNode);
}

function bindTaskScrollTracking() {
  if (taskScrollBound || !taskMessagesNode) {
    return;
  }

  taskMessagesNode.addEventListener("scroll", () => {
    state.ui.shouldStickToBottom = isNearBottom(taskMessagesNode);
    updateJumpButton();
  });
  taskScrollBound = true;
}

function updateViewportHeight() {
  const viewportHeight = window.visualViewport?.height || window.innerHeight;
  document.documentElement.style.setProperty("--app-height", `${Math.round(viewportHeight)}px`);
}

function renderConnection() {
  socketDot?.classList.toggle("online", state.connected);
  if (socketText) {
    socketText.textContent = state.connected
      ? "已连接"
      : state.auth.promptOpen
        ? "等待令牌"
        : "连接中断";
  }
}

function getApprovalNote(approvalId) {
  return state.ui.approvalNotes[approvalId] || "";
}

function setApprovalNote(approvalId, value) {
  state.ui.approvalNotes[approvalId] = String(value || "");
}

function setApprovalError(approvalId, message = "") {
  if (!approvalId) {
    return;
  }

  state.ui.approvalErrors[approvalId] = message;
}

function clearApprovalError(approvalId) {
  if (!approvalId) {
    return;
  }

  delete state.ui.approvalErrors[approvalId];
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
          <p class="muted">任务详情页也需要 App Token，确认后我再继续加载任务状态。</p>
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

function getStatusLabel(message) {
  return STATUS_LABELS[message?.status] || message?.status || "";
}

function buildMessageRenderSignature(conversationId, messages, hiddenMessageCount, showTyping) {
  return [
    conversationId || "none",
    hiddenMessageCount,
    showTyping ? "typing" : "idle",
    ...messages.map((message) =>
      [
        message.id,
        message.role,
        message.status || "",
        message.errorMessage || "",
        message.createdAt,
        message.text || "",
      ].join(":")
    ),
  ].join("|");
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

function approvalStateLabel(value) {
  return TASK_APPROVAL_LABELS[normalizeText(value)] || value || "未知";
}

function approvalStatusLabel(value) {
  return APPROVAL_STATUS_LABELS[normalizeText(value)] || value || "未知";
}

function submitApprovalDecision(approvalId, decision) {
  if (!approvalId || !state.socket || state.socket.readyState !== 1) {
    return;
  }

  state.ui.approvalPendingId = approvalId;
  clearApprovalError(approvalId);
  render();

  state.socket.send(
    JSON.stringify({
      type: "approval_decision",
      approvalId,
      decision,
      note: getApprovalNote(approvalId),
      taskId: route.taskId || "",
    })
  );
}

function bindApprovalActions() {
  document.querySelectorAll("[data-approval-note]").forEach((input) => {
    input.addEventListener("input", (event) => {
      setApprovalNote(input.dataset.approvalNote || "", event.target.value);
    });
  });

  document.querySelectorAll("[data-approval-decision]").forEach((button) => {
    button.addEventListener("click", () => {
      submitApprovalDecision(
        button.dataset.approvalId || "",
        button.dataset.approvalDecision || "approved"
      );
    });
  });
}

function buildStatusBadges(task, agent, workspace) {
  const statusTone = task?.blocked ? "blocked" : task?.active ? "active" : "idle";
  const badges = [
    {
      tone: statusTone,
      label: task?.statusLabel || "未命名状态",
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

function renderTaskSummary(task, conversation, agent, workspace, approvals) {
  const activeApprovalIds = new Set(approvals.map((item) => item.id));
  Object.keys(state.ui.approvalErrors).forEach((approvalId) => {
    if (!activeApprovalIds.has(approvalId)) {
      delete state.ui.approvalErrors[approvalId];
    }
  });

  if (!task) {
    if (taskPageSubtitle) {
      taskPageSubtitle.textContent = "当前链接没有找到对应任务，你可以返回 AI经理 重新查看。";
    }
    if (taskTitle) {
      taskTitle.textContent = "没有找到这条任务";
    }
    if (taskSubtitle) {
      taskSubtitle.textContent = route.taskId
        ? `任务 ${route.taskId} 目前不在快照里，可能已经被删除或还未同步。`
        : "当前没有可展示的任务。";
    }
    if (taskGoal) {
      taskGoal.textContent = "请返回 AI经理，让我重新定位你要查看的任务。";
    }
    if (taskProgress) {
      taskProgress.textContent = "任务详情为空时，不建议直接跳员工直连，以免打断错误对象。";
    }
    if (taskStatusBadges) {
      taskStatusBadges.innerHTML = "";
    }
    if (taskContextGrid) {
      taskContextGrid.innerHTML = "";
    }
    if (taskApprovalList) {
      taskApprovalList.innerHTML = "";
    }
    if (taskDirectLink) {
      taskDirectLink.hidden = true;
    }
    return;
  }

  const resolvedAgentName = agent?.name || task.agentName || route.agentName || "未分配员工";
  const resolvedDeviceName =
    agent?.deviceName || task.deviceName || route.deviceName || "未识别设备";
  const workspaceName = workspace?.name || task.workspaceName || "未绑定工作区";
  const lastUpdate = formatDateTime(task.updatedAt || task.lastUpdate);
  const directParams = new URLSearchParams();
  const directAgentId = task.agentId || route.agentId;
  const directConversationId = conversation?.id || task.conversationId || route.conversationId;

  if (taskPageSubtitle) {
    taskPageSubtitle.textContent = `${resolvedAgentName} · ${resolvedDeviceName}`;
  }
  if (taskTitle) {
    taskTitle.textContent = task.title || "未命名任务";
  }
  if (taskSubtitle) {
    taskSubtitle.textContent = `任务最后更新于 ${lastUpdate}，先看清执行状态，再决定是否亲自介入。`;
  }
  if (taskGoal) {
    taskGoal.textContent = task.lastUserText || task.title || "暂无任务目标";
  }
  if (taskProgress) {
    taskProgress.textContent = task.progressSummary || "还没有任务进展。";
  }
  if (taskStatusBadges) {
    taskStatusBadges.innerHTML = buildStatusBadges(task, agent, workspace);
  }
  if (taskContextGrid) {
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
  }
  if (taskApprovalList) {
    if (approvals.length === 0) {
      taskApprovalList.innerHTML = "";
    } else {
      taskApprovalList.innerHTML = approvals
        .map((approval) => {
          const updatedAt = formatDateTime(approval.updatedAt || approval.createdAt);
          const pending = approval.status === "pending";
          const busy = state.ui.approvalPendingId === approval.id;
          const errorMessage = state.ui.approvalErrors[approval.id] || "";
          return `
            <article class="task-approval-card ${escapeHtml(approval.status || "pending")}">
              <div class="task-approval-head">
                <strong>${escapeHtml(approvalStatusLabel(approval.status))}</strong>
                <span class="muted-text">${escapeHtml(updatedAt)}</span>
              </div>
              <p class="task-approval-copy">${escapeHtml(approval.reason || "需要审批")}</p>
              ${
                approval.requestedAction
                  ? `<p class="task-approval-meta">请求动作：${escapeHtml(approval.requestedAction)}</p>`
                  : ""
              }
              ${
                approval.resolutionNote
                  ? `<p class="task-approval-meta">处理说明：${escapeHtml(approval.resolutionNote)}</p>`
                  : ""
              }
              ${
                pending
                  ? `
                    <label class="task-approval-note-field">
                      <span>给员工的说明</span>
                      <textarea
                        rows="2"
                        placeholder="可选：补充批准或拒绝的原因"
                        data-approval-note="${escapeHtml(approval.id)}"
                      >${escapeHtml(getApprovalNote(approval.id))}</textarea>
                    </label>
                    <div class="task-approval-actions">
                      <button
                        type="button"
                        class="task-approval-button approve"
                        data-approval-id="${escapeHtml(approval.id)}"
                        data-approval-decision="approved"
                        ${busy || !state.connected ? "disabled" : ""}
                      >
                        ${busy ? "处理中..." : "批准"}
                      </button>
                      <button
                        type="button"
                        class="task-approval-button reject"
                        data-approval-id="${escapeHtml(approval.id)}"
                        data-approval-decision="rejected"
                        ${busy || !state.connected ? "disabled" : ""}
                      >
                        ${busy ? "处理中..." : "拒绝"}
                      </button>
                    </div>
                    ${
                      errorMessage
                        ? `<div class="task-approval-feedback error">${escapeHtml(errorMessage)}</div>`
                        : ""
                    }
                  `
                  : ""
              }
            </article>
          `;
        })
        .join("");
    }
  }
  if (taskDirectLink) {
    if (!directAgentId) {
      taskDirectLink.hidden = true;
    } else {
      directParams.set("agentId", directAgentId);
      if (directConversationId) {
        directParams.set("conversationId", directConversationId);
      }
      if (resolvedAgentName) {
        directParams.set("agentName", resolvedAgentName);
      }
      if (resolvedDeviceName) {
        directParams.set("deviceName", resolvedDeviceName);
      }
      taskDirectLink.href = `/direct.html?${directParams.toString()}`;
      taskDirectLink.hidden = false;
    }
  }
}

function renderConversation(task, conversation, agent, workspace, approvals) {
  const shouldAutoScroll =
    state.ui.pendingAutoScroll || isNearBottom(taskMessagesNode) || state.ui.shouldStickToBottom;

  if (!task) {
    if (taskConversationTitle) {
      taskConversationTitle.textContent = "相关对话";
    }
    if (taskConversationSubtitle) {
      taskConversationSubtitle.textContent = "当前没有可展示的任务会话。";
    }
    if (taskMessageToolbar) {
      taskMessageToolbar.innerHTML = "";
    }
    if (taskMessagesNode) {
      taskMessagesNode.innerHTML = `
        <div class="empty-card manager-empty-card">
          返回 AI经理 重新问一次，我会给你新的任务跳转入口。
        </div>
      `;
    }
    updateJumpButton();
    return;
  }

  if (taskConversationTitle) {
    taskConversationTitle.textContent = conversation?.title || task.title || "相关对话";
  }
  if (taskConversationSubtitle) {
    taskConversationSubtitle.textContent = conversation
      ? "这是这条任务关联会话的完整上下文。需要补充要求时，再进入员工直连。"
      : "这条任务目前还没有关联会话，可能还在分派或等待同步。";
  }
  if (taskMessageToolbar) {
    const pills = [
      task.statusLabel || task.status || "未知状态",
      agent?.online ? "员工在线" : "员工离线",
      workspace?.name ? `工作区 ${workspace.name}` : "未绑定工作区",
      `审批 ${approvalStateLabel(task.approvalState)}`,
      `更新 ${formatDateTime(task.updatedAt || task.lastUpdate)}`,
    ];
    if (approvals.length > 0) {
      pills.push(`审批记录 ${approvals.length} 条`);
    }
    taskMessageToolbar.innerHTML = pills
      .map((label) => `<span class="message-toolbar-pill">${escapeHtml(label)}</span>`)
      .join("");
  }
  if (!taskMessagesNode) {
    return;
  }

  const messages = conversation?.messages || [];
  const hiddenMessageCount = conversation?.hiddenMessageCount || 0;
  const lastMessage = messages[messages.length - 1] || null;
  const shouldShowTyping =
    lastMessage?.role === "user" &&
    ["queued", "sent", "processing"].includes(lastMessage.status);
  const renderSignature = buildMessageRenderSignature(
    conversation?.id || "",
    messages,
    hiddenMessageCount,
    shouldShowTyping
  );
  if (messages.length === 0) {
    state.ui.lastConversationRenderSignature = renderSignature;
    taskMessagesNode.innerHTML = `
      <div class="empty-card manager-empty-card">
        这条任务还没有同步到会话内容。通常是刚分派，或者员工还没开始回报。
      </div>
    `;
  } else {
    if (renderSignature === state.ui.lastConversationRenderSignature) {
      state.ui.pendingAutoScroll = false;
      requestAnimationFrame(updateJumpButton);
      return;
    }

    const historyNotice =
      hiddenMessageCount > 0
        ? `
          <div class="message-history-note">
            为保持页面流畅，这里只显示最近 ${messages.length} 条任务会话，已折叠更早的 ${hiddenMessageCount} 条。
          </div>
        `
        : "";

    taskMessagesNode.innerHTML =
      historyNotice +
      messages
      .map((message) => {
        const roleClass = message.role === "assistant" ? "assistant" : "user";
        const statusLabel = message.role === "user" ? getStatusLabel(message) : "";
        const statusMarkup = statusLabel
          ? `<span class="status-tag status-${escapeHtml(message.status || "")}">${escapeHtml(statusLabel)}</span>`
          : "";
        const errorMarkup =
          message.role === "user" && message.errorMessage
            ? `<div class="message-note error">${escapeHtml(message.errorMessage)}</div>`
            : "";

        return `
          <article class="message ${roleClass}">
            <div class="bubble">
              <p>${escapeHtml(message.text || "").replaceAll("\n", "<br />")}</p>
            </div>
            <div class="meta">
              <span>${formatTime(message.createdAt)}</span>
              ${statusMarkup}
            </div>
            ${errorMarkup}
          </article>
        `;
      })
      .join("");

    state.ui.lastConversationRenderSignature = renderSignature;
  }

  if (shouldAutoScroll) {
    requestAnimationFrame(() => {
      taskMessagesNode.scrollTo({
        top: taskMessagesNode.scrollHeight,
        behavior: "smooth",
      });
      state.ui.shouldStickToBottom = true;
      state.ui.pendingAutoScroll = false;
      updateJumpButton();
    });
  } else {
    state.ui.pendingAutoScroll = false;
    requestAnimationFrame(updateJumpButton);
  }
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

  renderTaskSummary(task, conversation, agent, workspace, approvals);
  renderConversation(task, conversation, agent, workspace, approvals);
  bindApprovalActions();
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
      })
    );
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
      state.auth.promptOpen = false;
      state.auth.blocked = false;
      state.auth.error = "";
      state.snapshot = payload.data || null;
      if (state.ui.approvalPendingId) {
        const stillPending = (state.snapshot?.approvals || []).some(
          (approval) =>
            approval.id === state.ui.approvalPendingId && approval.status === "pending"
        );
        if (!stillPending) {
          state.ui.approvalPendingId = "";
        }
      }
      render();
      return;
    }

    if (payload.type === "approval_decision_result") {
      if (payload.approvalId && state.ui.approvalPendingId === payload.approvalId) {
        state.ui.approvalPendingId = "";
      }

      if (!payload.result?.ok) {
        setApprovalError(
          payload.approvalId,
          payload.result?.message || "审批处理失败，请稍后重试。"
        );
      } else if (payload.approvalId) {
        clearApprovalError(payload.approvalId);
      }

      render();
      return;
    }

    if (payload.type === "error" && payload.message) {
      console.error(payload.message);
    }
  });
}

taskMessageJumpButton?.addEventListener("click", () => {
  taskMessagesNode?.scrollTo({
    top: taskMessagesNode.scrollHeight,
    behavior: "smooth",
  });
});

window.addEventListener("resize", updateViewportHeight);
window.visualViewport?.addEventListener("resize", updateViewportHeight);

updateViewportHeight();
bindTaskScrollTracking();
connect();
render();
