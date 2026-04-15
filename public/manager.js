import { bindCopyMessageButtons, renderCopyMessageButton } from "./message-copy.js";

const UI_PREFS_KEY = "agenthub-manager-ui-v1";
const APP_TOKEN_STORAGE_KEY = "agenthub-app-token-v1";
const STATUS_LABELS = {
  queued: "排队中",
  sent: "已发送",
  processing: "处理中",
  answered: "已完成",
  failed: "失败",
};
const route = (() => {
  const params = new URLSearchParams(window.location.search);
  return {
    prompt: (params.get("prompt") || "").trim(),
  };
})();

const state = {
  connected: false,
  socket: null,
  agents: [],
  devices: [],
  tasks: [],
  manager: {
    messages: [],
    totalMessageCount: 0,
    hiddenMessageCount: 0,
    provider: "local",
    model: "local-summary",
    summary: {
      onlineAgentCount: 0,
      totalAgentCount: 0,
      activeTaskCount: 0,
      blockedTaskCount: 0,
      recentTaskCount: 0,
    },
  },
  auth: {
    token: loadStoredAppToken(),
    input: "",
    promptOpen: false,
    blocked: false,
    error: "",
  },
  ui: {
    contextCollapsed: loadUiState().contextCollapsed,
    shouldStickToBottom: true,
    pendingAutoScroll: true,
    lastRenderSignature: "",
  },
};

const socketDot = document.querySelector("#socket-dot");
const socketText = document.querySelector("#socket-text");
const managerSubtitle = document.querySelector("#manager-subtitle");
const managerContextToggleButton = document.querySelector("#manager-context-toggle-button");
const managerCollapsedSummary = document.querySelector("#manager-collapsed-summary");
const managerStatusStrip = document.querySelector("#manager-status-strip");
const managerMessagesNode = document.querySelector("#manager-messages");
const managerComposer = document.querySelector("#manager-composer");
const managerInput = document.querySelector("#manager-input");
const managerSendButton = document.querySelector("#manager-send-button");
const authModal = document.querySelector("#auth-modal");
const authModalContent = document.querySelector("#auth-modal-content");
let managerScrollBound = false;
let routePromptApplied = false;

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

function loadUiState() {
  try {
    const raw = window.localStorage.getItem(UI_PREFS_KEY);
    if (!raw) {
      return { contextCollapsed: true };
    }

    const parsed = JSON.parse(raw);
    return {
      contextCollapsed: parsed?.contextCollapsed !== false,
    };
  } catch {
    return { contextCollapsed: true };
  }
}

function persistUiState() {
  try {
    window.localStorage.setItem(
      UI_PREFS_KEY,
      JSON.stringify({
        contextCollapsed: state.ui.contextCollapsed,
      })
    );
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
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function getStatusLabel(message) {
  return STATUS_LABELS[message?.status] || message?.status || "";
}

function setManagerInputValue(value) {
  if (!managerInput) {
    return;
  }

  managerInput.value = value;
  syncComposerHeight();
}

function buildMessageRenderSignature(messages, hiddenMessageCount, showTyping) {
  const starterSignature = messages.length === 0 ? buildStarterPrompts().join("|") : "";
  return [
    starterSignature,
    hiddenMessageCount,
    showTyping ? "typing" : "idle",
    ...messages.map((message) =>
      [
        message.id,
        message.role,
        message.status || "",
        message.errorMessage || "",
        message.action?.type || "",
        message.createdAt,
        message.text,
      ].join(":")
    ),
  ].join("|");
}

function isNearBottom(node, threshold = 40) {
  if (!node) {
    return true;
  }

  const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
  return distance <= threshold;
}

function bindManagerScrollTracking() {
  if (managerScrollBound || !managerMessagesNode) {
    return;
  }

  managerMessagesNode.addEventListener("scroll", () => {
    state.ui.shouldStickToBottom = isNearBottom(managerMessagesNode);
  });
  managerScrollBound = true;
}

function updateViewportHeight() {
  const viewportHeight = window.visualViewport?.height || window.innerHeight;
  document.documentElement.style.setProperty("--app-height", `${Math.round(viewportHeight)}px`);
}

function syncComposerHeight() {
  if (!managerInput) {
    return;
  }

  managerInput.style.height = "auto";
  managerInput.style.height = `${Math.min(managerInput.scrollHeight, 160)}px`;
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
  const token = String(rawToken || "").trim();
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

function applyRoutePrompt() {
  if (!route.prompt || !managerInput) {
    return;
  }

  if (!managerInput.value.trim()) {
    setManagerInputValue(route.prompt);
  }

  if (state.auth.promptOpen) {
    return;
  }

  if (routePromptApplied) {
    return;
  }

  routePromptApplied = true;
  requestAnimationFrame(() => {
    managerInput.focus();
    const cursor = managerInput.value.length;
    managerInput.setSelectionRange(cursor, cursor);
  });

  const nextUrl = new URL(window.location.href);
  nextUrl.searchParams.delete("prompt");
  window.history.replaceState({}, "", `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`);
}

function buildActionHref(action) {
  if (!action?.type) {
    return null;
  }

  const params = new URLSearchParams();

  if (action.type === "open_task_detail") {
    if (!action.taskId) {
      return null;
    }

    params.set("taskId", action.taskId);
    if (action.conversationId) {
      params.set("conversationId", action.conversationId);
    }
    if (action.agentId) {
      params.set("agentId", action.agentId);
    }
    if (action.agentName) {
      params.set("agentName", action.agentName);
    }
    if (action.deviceName) {
      params.set("deviceName", action.deviceName);
    }

    return `/task.html?${params.toString()}`;
  }

  if (action.type === "switch_direct") {
    if (!action.agentId) {
      return null;
    }

    params.set("agentId", action.agentId);
    if (action.conversationId) {
      params.set("conversationId", action.conversationId);
    }
    if (action.agentName) {
      params.set("agentName", action.agentName);
    }
    if (action.deviceName) {
      params.set("deviceName", action.deviceName);
    }

    return `/direct.html?${params.toString()}`;
  }

  return null;
}

function openManagerAction(action) {
  const href = buildActionHref(action);
  if (!href) {
    return;
  }

  window.location.href = href;
}

function renderManagerActionCard(action) {
  if (!action?.type || !buildActionHref(action)) {
    return "";
  }

  const title =
    action.title ||
    (action.type === "open_task_detail"
      ? "查看任务详情"
      : `查看 ${action.agentName || action.agentId} 的执行细节`);
  const description =
    action.description ||
    (action.type === "open_task_detail"
      ? "先看任务状态、工作区和最近进展，再决定要不要直连员工。"
      : "进入该员工的直连页，查看当前任务、对话和上下文。");
  const buttonLabel = action.label || "查看详情并跳转";

  return `
    <div class="manager-action-card">
      <div class="manager-action-copy">
        <strong>${escapeHtml(title)}</strong>
        <p>${escapeHtml(description)}</p>
      </div>
      <button
        type="button"
        class="manager-action-button"
        data-manager-action="${encodeURIComponent(JSON.stringify(action))}"
      >
        ${escapeHtml(buttonLabel)}
      </button>
    </div>
  `;
}

function buildManagerStatusItems() {
  const summary = state.manager.summary || {};
  const onlineAgentCount = Number(summary.onlineAgentCount || 0);
  const totalAgentCount = Number(summary.totalAgentCount || 0);
  const activeTaskCount = Number(summary.activeTaskCount || 0);
  const pendingApprovalCount = Number(summary.pendingApprovalCount || 0);
  const blockedTaskCount = Number(summary.blockedTaskCount || 0);

  const items = [
    `${onlineAgentCount}/${totalAgentCount} 位员工在线`,
    activeTaskCount > 0 ? `${activeTaskCount} 个任务处理中` : "当前没有执行中的任务",
  ];

  if (pendingApprovalCount > 0) {
    items.push(`${pendingApprovalCount} 个任务待你确认`);
  }

  if (blockedTaskCount > 0) {
    items.push(`${blockedTaskCount} 个任务阻塞`);
  }

  if (!window.matchMedia("(max-width: 720px)").matches) {
    items.push(
      state.manager.provider === "local"
        ? "经理层：本地摘要"
        : `经理层：${state.manager.provider} · ${state.manager.model || "已连接模型"}`
    );
  }

  return items;
}

function buildStarterPrompts() {
  const preferredAgent =
    [...state.agents].sort((left, right) => Number(Boolean(right.online)) - Number(Boolean(left.online)))[0] ||
    null;

  return [
    "现在我的员工有哪些",
    "他们现在在做什么",
    "谁卡住了，需要我介入",
    preferredAgent
      ? `帮我切到和 ${preferredAgent.name} 的对话`
      : "帮我看看当前谁在线",
  ];
}

function renderStarterPrompts() {
  const prompts = buildStarterPrompts();
  return `
    <div class="manager-starter-card">
      <strong>你不用先理解系统结构，直接这样问我就行：</strong>
      <div class="manager-starter-list">
        ${prompts
          .map(
            (prompt) => `
              <button
                type="button"
                class="manager-starter-button"
                data-manager-prompt="${escapeHtml(prompt)}"
              >
                ${escapeHtml(prompt)}
              </button>
            `
          )
          .join("")}
      </div>
    </div>
  `;
}

function renderManagerPanel() {
  const shouldAutoScroll =
    state.ui.pendingAutoScroll || isNearBottom(managerMessagesNode) || state.ui.shouldStickToBottom;

  if (managerSubtitle) {
    managerSubtitle.textContent =
      state.manager.provider === "local"
        ? "我现在先用本地摘要接管工作台，照样可以帮你盘点员工、任务和进度。"
        : "直接告诉我你要推进什么，我先判断、再调度；想看细节时我再给你跳转卡片。";
  }

  if (managerStatusStrip) {
    managerStatusStrip.innerHTML = buildManagerStatusItems()
      .map((item) => `<span class="manager-status-pill">${escapeHtml(item)}</span>`)
      .join("");
  }

  if (managerContextToggleButton) {
    managerContextToggleButton.textContent = state.ui.contextCollapsed ? "展开" : "收起";
    managerContextToggleButton.setAttribute(
      "aria-label",
      state.ui.contextCollapsed ? "展开顶部内容" : "收起顶部内容"
    );
  }

  if (managerCollapsedSummary) {
    managerCollapsedSummary.hidden = !state.ui.contextCollapsed;
    managerCollapsedSummary.textContent =
      buildManagerStatusItems().join(" · ") || "展开后可以看到经理说明和当前状态。";
  }

  if (managerSubtitle) {
    managerSubtitle.hidden = state.ui.contextCollapsed;
  }

  if (managerStatusStrip) {
    managerStatusStrip.hidden = state.ui.contextCollapsed;
  }

  const messages = state.manager.messages || [];
  const hiddenMessageCount = state.manager.hiddenMessageCount || 0;
  const lastMessage = messages[messages.length - 1] || null;
  const shouldShowTyping =
    lastMessage?.role === "user" &&
    ["queued", "sent", "processing"].includes(lastMessage.status);
  const renderSignature = buildMessageRenderSignature(
    messages,
    hiddenMessageCount,
    shouldShowTyping
  );

  if (renderSignature === state.ui.lastRenderSignature) {
    managerSendButton.disabled = !state.connected;
    state.ui.pendingAutoScroll = false;
    return;
  }

  if (messages.length === 0) {
    managerMessagesNode.innerHTML = `
      <div class="empty-card manager-empty-card">
        <p>先直接告诉我目标，例如“现在我的员工有哪些”“他们现在在做什么”“帮我切到和 Codex Main 的对话”。</p>
        ${renderStarterPrompts()}
      </div>
    `;
  } else {
    const historyNotice =
      hiddenMessageCount > 0
        ? `
          <div class="message-history-note">
            为保持页面流畅，这里只显示最近 ${messages.length} 条经理记录，已折叠更早的 ${hiddenMessageCount} 条。
          </div>
        `
        : "";

    managerMessagesNode.innerHTML =
      historyNotice +
      messages
      .map((message) => {
        const roleClass = message.role === "assistant" ? "assistant" : "user";
        const statusLabel = message.role === "user" ? getStatusLabel(message) : "";
        const statusMarkup = statusLabel
          ? `<span class="status-tag status-${escapeHtml(message.status || "")}">${escapeHtml(statusLabel)}</span>`
          : "";
        const copyMarkup = message.text ? renderCopyMessageButton(message.id) : "";
        const errorMarkup =
          message.role === "user" && message.errorMessage
            ? `<div class="message-note error">${escapeHtml(message.errorMessage)}</div>`
            : "";
        const actionMarkup =
          message.role === "assistant" ? renderManagerActionCard(message.action) : "";

        return `
          <article class="message ${roleClass}">
            <div class="bubble">
              <p>${escapeHtml(message.text).replaceAll("\n", "<br />")}</p>
            </div>
            <div class="meta">
              <span>${formatTime(message.createdAt)}</span>
              ${statusMarkup}
              ${copyMarkup}
            </div>
            ${actionMarkup}
            ${errorMarkup}
          </article>
        `;
      })
      .join("");

    if (shouldShowTyping) {
      managerMessagesNode.innerHTML += `
        <article class="message assistant transient">
          <div class="bubble typing-bubble">
            <span></span><span></span><span></span>
          </div>
          <div class="meta">
            <span>AI经理正在汇总</span>
          </div>
        </article>
      `;
    }
  }

  state.ui.lastRenderSignature = renderSignature;

  managerMessagesNode.querySelectorAll("[data-manager-action]").forEach((button) => {
    button.addEventListener("click", () => {
      const raw = button.dataset.managerAction;
      if (!raw) {
        return;
      }

      try {
        openManagerAction(JSON.parse(decodeURIComponent(raw)));
      } catch (error) {
        console.error(error);
      }
    });
  });

  managerMessagesNode.querySelectorAll("[data-manager-prompt]").forEach((button) => {
    button.addEventListener("click", () => {
      const prompt = button.dataset.managerPrompt || "";
      setManagerInputValue(prompt);
      managerInput.focus();
      const cursor = managerInput.value.length;
      managerInput.setSelectionRange(cursor, cursor);
    });
  });

  bindCopyMessageButtons(managerMessagesNode, (messageId) => {
    const message = (state.manager.messages || []).find((item) => item.id === messageId);
    return message?.text || "";
  });

  managerSendButton.disabled = !state.connected;
  if (shouldAutoScroll) {
    requestAnimationFrame(() => {
      managerMessagesNode.scrollTo({
        top: managerMessagesNode.scrollHeight,
        behavior: "smooth",
      });
      state.ui.shouldStickToBottom = true;
      state.ui.pendingAutoScroll = false;
    });
  } else {
    state.ui.pendingAutoScroll = false;
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
          <p class="muted">这个 AgentHub 受保护。输入 App Token 后，经理才能开始接管任务。</p>
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
  renderManagerPanel();
  renderAuthPrompt();
  applyRoutePrompt();
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
      state.agents = payload.data.agents || [];
      state.devices = payload.data.devices || [];
      state.tasks = payload.data.tasks || [];
      state.manager = payload.data.manager || state.manager;
      render();
      return;
    }

  });
}

managerComposer.addEventListener("submit", (event) => {
  event.preventDefault();

  const text = managerInput.value.trim();
  if (!text || !state.socket || state.socket.readyState !== 1) {
    return;
  }

  state.socket.send(
    JSON.stringify({
      type: "manager_message",
      text,
    })
  );

  setManagerInputValue("");
  state.ui.pendingAutoScroll = true;
  managerInput.focus();
});

managerInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    managerComposer.requestSubmit();
  }
});
managerInput.addEventListener("input", syncComposerHeight);

window.addEventListener("resize", updateViewportHeight);
window.visualViewport?.addEventListener("resize", updateViewportHeight);

managerContextToggleButton?.addEventListener("click", () => {
  state.ui.contextCollapsed = !state.ui.contextCollapsed;
  persistUiState();
  renderManagerPanel();
});

updateViewportHeight();
bindManagerScrollTracking();
syncComposerHeight();
connect();
render();
