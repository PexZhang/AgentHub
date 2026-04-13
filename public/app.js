const UI_PREFS_KEY = "agenthub-ui-prefs-v1";
const APP_TOKEN_STORAGE_KEY = "agenthub-app-token-v1";

function buildDefaultUiState() {
  return {
    threadsCollapsed: window.matchMedia("(max-width: 720px)").matches,
  };
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

function loadUiState() {
  const defaults = buildDefaultUiState();

  try {
    const raw = window.localStorage.getItem(UI_PREFS_KEY);
    if (!raw) {
      return defaults;
    }

    return {
      ...defaults,
      ...JSON.parse(raw),
    };
  } catch {
    return defaults;
  }
}

const state = {
  connected: false,
  socket: null,
  agents: [],
  conversations: [],
  activeAgentId: null,
  activeConversationId: null,
  pendingConversationId: null,
  ui: loadUiState(),
  messageViewport: {
    stickToBottom: true,
    showJumpButton: false,
    lastConversationId: null,
    lastMessageCount: 0,
  },
  auth: {
    token: loadStoredAppToken(),
    input: "",
    promptOpen: false,
    blocked: false,
    error: "",
  },
  sessionPicker: {
    open: false,
    agentId: null,
  },
  directoryPicker: {
    open: false,
    agentId: null,
    currentPath: "",
    parentPath: null,
    inputPath: "",
    roots: [],
    entries: [],
    loading: false,
    error: "",
    requestId: null,
    requestTimer: null,
  },
};

const socketDot = document.querySelector("#socket-dot");
const socketText = document.querySelector("#socket-text");
const agentCount = document.querySelector("#agent-count");
const agentList = document.querySelector("#agent-list");
const conversationTitle = document.querySelector("#conversation-title");
const conversationSubtitle = document.querySelector("#conversation-subtitle");
const threadStrip = document.querySelector("#thread-strip");
const messageStage = document.querySelector("#message-stage");
const messageToolbar = document.querySelector("#message-toolbar");
const messagesNode = document.querySelector("#messages");
const messageJumpButton = document.querySelector("#message-jump-button");
const composer = document.querySelector("#composer");
const messageInput = document.querySelector("#message-input");
const sendButton = document.querySelector("#send-button");
const directoryPickerModal = document.querySelector("#directory-picker-modal");
const directoryPickerContent = document.querySelector("#directory-picker-content");
const sessionPickerModal = document.querySelector("#session-picker-modal");
const sessionPickerContent = document.querySelector("#session-picker-content");
const authModal = document.querySelector("#auth-modal");
const authModalContent = document.querySelector("#auth-modal-content");

const STATUS_LABELS = {
  queued: "排队中",
  sent: "已发送",
  processing: "处理中",
  answered: "已完成",
  failed: "失败",
};
const DIRECTORY_REQUEST_TIMEOUT_MS = 4000;

function updateViewportHeight() {
  const viewportHeight = window.visualViewport?.height || window.innerHeight;
  document.documentElement.style.setProperty("--app-height", `${Math.round(viewportHeight)}px`);
}

function persistUiState() {
  try {
    window.localStorage.setItem(UI_PREFS_KEY, JSON.stringify(state.ui));
  } catch {
    // Ignore storage write failures.
  }
}

function openAuthPrompt(message = "") {
  state.auth.promptOpen = true;
  state.auth.blocked = true;
  state.auth.error = message || state.auth.error || "请输入访问令牌以连接这个公网 AgentHub。";
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

function createRequestId() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }

  return `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function formatTime(value) {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatUpdatedAt(value) {
  if (!value) {
    return "未知时间";
  }

  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function shortenId(value) {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }

  return text.length <= 8 ? text : text.slice(0, 8);
}

function getLastMessage(conversation) {
  const messages = conversation?.messages || [];
  return messages.length > 0 ? messages[messages.length - 1] : null;
}

function getLeafName(path) {
  const normalized = String(path || "").replace(/\/+$/, "");
  if (!normalized) {
    return "/";
  }

  const parts = normalized.split("/");
  return parts[parts.length - 1] || "/";
}

function getAgent(agentId) {
  return state.agents.find((agent) => agent.id === agentId) || null;
}

function getConversationsForAgent(agentId) {
  return state.conversations
    .filter((conversation) => conversation.agentId === agentId)
    .sort(
      (left, right) =>
        new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
    );
}

function getActiveConversation() {
  if (!state.activeConversationId) {
    return null;
  }

  return (
    state.conversations.find(
      (conversation) => conversation.id === state.activeConversationId
    ) || null
  );
}

function getAgentDefaultWorkdir(agent) {
  return (
    agent?.defaultCodexWorkdir ||
    agent?.workdirRoots?.[0] ||
    ""
  );
}

function agentUsesCodex(agent) {
  return Boolean(agent && agent.mode === "codex");
}

function getRuntimeLabel(agent) {
  if (!agent) {
    return "未连接";
  }

  if (agent.mode === "offline") {
    return "未连接";
  }

  if (agent.mode === "codex") {
    return "Codex";
  }

  if (agent.mode === "openai") {
    return "OpenAI";
  }

  return "Echo";
}

function toggleUiPanel(panelKey) {
  state.ui[panelKey] = !state.ui[panelKey];
  persistUiState();
  render();
}

function closeSessionPicker() {
  state.sessionPicker.open = false;
  state.sessionPicker.agentId = null;
  renderSessionPicker();
}

function openSessionPicker(agentId) {
  state.sessionPicker.open = true;
  state.sessionPicker.agentId = agentId;
  renderSessionPicker();
}

function selectAgent(agentId) {
  state.pendingConversationId = null;
  state.activeAgentId = agentId;
  const conversations = getConversationsForAgent(agentId);
  const hasActiveConversation = conversations.some(
    (conversation) => conversation.id === state.activeConversationId
  );

  if (!hasActiveConversation) {
    state.activeConversationId = conversations[0]?.id || null;
  }
}

function ensureActiveSelection() {
  if (state.pendingConversationId) {
    const pendingConversation = state.conversations.find(
      (conversation) => conversation.id === state.pendingConversationId
    );

    if (pendingConversation) {
      state.activeConversationId = pendingConversation.id;
      state.activeAgentId = pendingConversation.agentId;
      state.pendingConversationId = null;
      return;
    }

    return;
  }

  const activeConversation = getActiveConversation();
  if (activeConversation) {
    state.activeAgentId = activeConversation.agentId;
  }

  if (
    state.activeAgentId &&
    state.agents.some((agent) => agent.id === state.activeAgentId)
  ) {
    const conversations = getConversationsForAgent(state.activeAgentId);
    if (
      state.activeConversationId &&
      conversations.some((conversation) => conversation.id === state.activeConversationId)
    ) {
      return;
    }

    state.activeConversationId = conversations[0]?.id || null;
    return;
  }

  const onlineAgent = state.agents.find((agent) => agent.online);
  const fallbackAgent = onlineAgent?.id || state.agents[0]?.id || null;
  if (!fallbackAgent) {
    state.activeAgentId = null;
    state.activeConversationId = null;
    return;
  }

  selectAgent(fallbackAgent);
}

function sendAction(payload) {
  if (!state.socket || state.socket.readyState !== 1) {
    return false;
  }

  state.socket.send(JSON.stringify(payload));
  return true;
}

function requestNewConversation(agentId) {
  if (!agentId) {
    return;
  }

  sendAction({
    type: "create_conversation",
    agentId,
    title: "New chat",
  });
}

function requestNewCodexConversation(agentId, workdir) {
  if (!agentId) {
    return;
  }

  sendAction({
    type: "create_conversation",
    agentId,
    title: "New chat",
    codexWorkdir: workdir || null,
  });
}

function requestOpenCodexSession(agent, session, fallbackWorkdir = null) {
  if (!agent?.id || !session?.id) {
    return;
  }

  sendAction({
    type: "open_codex_session",
    agentId: agent.id,
    codexSessionId: session.id,
    codexThreadName: session.threadName,
    codexSessionUpdatedAt: session.updatedAt,
    codexWorkdir: fallbackWorkdir || getAgentDefaultWorkdir(agent) || null,
  });
}

function requestDeleteConversation(conversationId) {
  if (!conversationId) {
    return;
  }

  sendAction({
    type: "delete_conversation",
    conversationId,
  });
}

function closeDirectoryPicker() {
  if (state.directoryPicker.requestTimer) {
    window.clearTimeout(state.directoryPicker.requestTimer);
  }

  state.directoryPicker = {
    open: false,
    agentId: null,
    currentPath: "",
    parentPath: null,
    inputPath: "",
    roots: [],
    entries: [],
    loading: false,
    error: "",
    requestId: null,
    requestTimer: null,
  };
  renderDirectoryPicker();
}

function requestDirectoryList(agentId, path) {
  if (state.directoryPicker.requestTimer) {
    window.clearTimeout(state.directoryPicker.requestTimer);
  }

  const requestId = createRequestId();
  state.directoryPicker.loading = true;
  state.directoryPicker.error = "";
  state.directoryPicker.requestId = requestId;
  state.directoryPicker.requestTimer = window.setTimeout(() => {
    if (state.directoryPicker.requestId !== requestId) {
      return;
    }

    state.directoryPicker.loading = false;
    state.directoryPicker.requestTimer = null;
    state.directoryPicker.error =
      "目录服务没有响应。通常是本地 Agent 还没重启到支持目录浏览的新版本，请重启 `npm run agent` 后再试。";
    renderDirectoryPicker();
  }, DIRECTORY_REQUEST_TIMEOUT_MS);
  const sent = sendAction({
    type: "list_agent_directories",
    agentId,
    requestId,
    path,
  });

  if (!sent) {
    state.directoryPicker.loading = false;
    state.directoryPicker.error = "当前连接不可用，无法读取目录";
    state.directoryPicker.requestTimer = null;
  }

  renderDirectoryPicker();
}

function openDirectoryPicker(agent, preferredPath = "") {
  const initialPath = preferredPath || getAgentDefaultWorkdir(agent);
  state.directoryPicker = {
    open: true,
    agentId: agent.id,
    currentPath: "",
    parentPath: null,
    inputPath: initialPath,
    roots: agent.workdirRoots || [],
    entries: [],
    loading: true,
    error: "",
    requestId: null,
    requestTimer: null,
  };
  renderDirectoryPicker();
  requestDirectoryList(agent.id, initialPath);
}

function handleDirectoryList(payload) {
  if (
    !state.directoryPicker.open ||
    payload.agentId !== state.directoryPicker.agentId ||
    payload.requestId !== state.directoryPicker.requestId
  ) {
    return;
  }

  state.directoryPicker.loading = false;
  if (state.directoryPicker.requestTimer) {
    window.clearTimeout(state.directoryPicker.requestTimer);
  }
  state.directoryPicker.requestTimer = null;
  state.directoryPicker.error = payload.error || "";

  if (!payload.error) {
    state.directoryPicker.currentPath = payload.path || state.directoryPicker.currentPath;
    state.directoryPicker.parentPath = payload.parentPath || null;
    state.directoryPicker.inputPath = payload.path || state.directoryPicker.inputPath;
    state.directoryPicker.roots = Array.isArray(payload.roots)
      ? payload.roots
      : state.directoryPicker.roots;
    state.directoryPicker.entries = Array.isArray(payload.entries) ? payload.entries : [];
  }

  renderDirectoryPicker();
}

function renderAgents() {
  agentCount.textContent = `${state.agents.filter((agent) => agent.online).length} online`;

  if (state.agents.length === 0) {
    agentList.innerHTML =
      '<div class="empty-card">还没有 Agent 连上来。先运行本地 Agent，再从手机打开这个页面。</div>';
    return;
  }

  agentList.innerHTML = state.agents
    .map((agent) => {
      const activeClass = agent.id === state.activeAgentId ? " active" : "";
      const offlineClass = agent.online ? "" : " offline";
      return `
        <button class="agent-chip${activeClass}${offlineClass}" data-agent-id="${escapeHtml(agent.id)}">
          <span class="agent-chip-title">${escapeHtml(agent.name)}</span>
          <span class="agent-chip-meta">
            ${agent.online ? "在线" : "离线"} · 运行时 ${escapeHtml(getRuntimeLabel(agent))}
          </span>
        </button>
      `;
    })
    .join("");

  agentList.querySelectorAll("[data-agent-id]").forEach((button) => {
    button.addEventListener("click", () => {
      selectAgent(button.dataset.agentId);
      render();
    });
  });
}

function renderThreadStrip(agent) {
  if (!agent) {
    threadStrip.innerHTML = "";
    return;
  }

  const conversations = getConversationsForAgent(agent.id);
  const collapsed = state.ui.threadsCollapsed;
  const disabled = !state.connected ? " disabled" : "";
  const activeConversation = getActiveConversation();
  const usesCodex = agentUsesCodex(agent);
  const activeTitle = activeConversation?.title || "未选择线程";
  const latestAt = activeConversation?.updatedAt
    ? formatUpdatedAt(activeConversation.updatedAt)
    : "暂无消息";
  const activeSummary =
    usesCodex && activeConversation?.codexWorkdir
      ? `${activeTitle} · ${getLeafName(activeConversation.codexWorkdir)}`
      : activeTitle;

  threadStrip.innerHTML = `
    <div class="thread-toolbar">
      <button class="section-toggle-button" id="thread-toggle-button" type="button">
        <span class="thread-label">聊天线程</span>
        <span class="section-toggle-meta">${conversations.length} 个</span>
        <span class="section-toggle-state">${collapsed ? "展开" : "收起"}</span>
      </button>
      <div class="thread-toolbar-actions">
        ${
          usesCodex
            ? `<button class="session-action-button${disabled}" id="thread-import-button" ${!state.connected ? "disabled" : ""}>导入旧会话</button>`
            : ""
        }
        <button class="thread-create${disabled}" id="thread-create-button" ${!state.connected ? "disabled" : ""}>
          新线程
        </button>
      </div>
    </div>
    ${
      collapsed
        ? `<div class="section-collapsed-summary">当前线程：${escapeHtml(activeSummary)} · ${escapeHtml(latestAt)}</div>`
        : `
            <div class="thread-list">
              ${
                conversations.length > 0
                  ? conversations
                      .map((conversation) => {
                        const active = conversation.id === state.activeConversationId ? " active" : "";
                        const workdirLine = usesCodex && conversation.codexWorkdir
                          ? `<span class="thread-chip-path">${escapeHtml(getLeafName(conversation.codexWorkdir))}</span>`
                          : "";
                        const statusBadge =
                          usesCodex && !conversation.codexSessionId
                            ? '<span class="thread-badge pending">待创建</span>'
                            : "";
                        return `
                          <div class="thread-card${active}">
                            <button class="thread-chip${active}" data-conversation-id="${escapeHtml(conversation.id)}" type="button">
                              <span class="thread-chip-title">${escapeHtml(conversation.title || "New chat")}</span>
                              <span class="thread-chip-meta">${formatUpdatedAt(conversation.updatedAt)}</span>
                              ${workdirLine}
                              ${statusBadge}
                            </button>
                            <button
                              class="thread-delete-button"
                              data-delete-conversation-id="${escapeHtml(conversation.id)}"
                              data-delete-conversation-title="${escapeHtml(conversation.title || "New chat")}"
                              type="button"
                              aria-label="删除会话"
                              title="删除会话"
                            >
                              删除
                            </button>
                          </div>
                        `;
                      })
                      .join("")
                  : '<div class="empty-inline">这个 Agent 还没有聊天线程，先新建一个。</div>'
              }
            </div>
          `
    }
  `;

  threadStrip.querySelector("#thread-toggle-button")?.addEventListener("click", () => {
    toggleUiPanel("threadsCollapsed");
  });

  threadStrip.querySelector("#thread-create-button")?.addEventListener("click", () => {
    if (usesCodex) {
      openDirectoryPicker(
        agent,
        activeConversation?.codexWorkdir || getAgentDefaultWorkdir(agent)
      );
      return;
    }

    requestNewConversation(agent.id);
  });

  threadStrip.querySelector("#thread-import-button")?.addEventListener("click", () => {
    openSessionPicker(agent.id);
  });

  if (collapsed) {
    return;
  }

  threadStrip.querySelectorAll("[data-conversation-id]").forEach((button) => {
    button.addEventListener("click", () => {
      state.activeConversationId = button.dataset.conversationId;
      render();
    });
  });

  threadStrip.querySelectorAll("[data-delete-conversation-id]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const conversationId = button.dataset.deleteConversationId;
      const title = button.dataset.deleteConversationTitle || "这个会话";
      const confirmed = window.confirm(`确认删除“${title}”吗？删除后聊天记录不可恢复。`);
      if (!confirmed) {
        return;
      }

      requestDeleteConversation(conversationId);
    });
  });
}

function renderSessionPicker() {
  if (!state.sessionPicker.open) {
    sessionPickerModal.hidden = true;
    sessionPickerContent.innerHTML = "";
    return;
  }

  const agent = getAgent(state.sessionPicker.agentId);
  if (!agent || !agentUsesCodex(agent)) {
    closeSessionPicker();
    return;
  }

  const conversation = getActiveConversation();
  const sessions = agent?.recentCodexSessions || [];
  const fallbackWorkdir = conversation?.codexWorkdir || getAgentDefaultWorkdir(agent);

  sessionPickerModal.hidden = false;
  sessionPickerContent.innerHTML = `
    <div class="session-modal-card">
      <div class="session-modal-head">
        <div>
          <h3>导入旧会话</h3>
          <p class="muted">这些是本机已有的 Codex 会话。选择后，AgentHub 会打开或切换到对应会话。</p>
        </div>
        <button class="directory-close-button" id="session-close-button" type="button">关闭</button>
      </div>

      <div class="session-modal-summary">
        当前线程：${escapeHtml(conversation?.title || "未选择线程")} · 工作目录 ${escapeHtml(fallbackWorkdir || "未设置")}
      </div>

      <div class="session-picker-list">
        ${
          sessions.length > 0
            ? sessions
                .map((session) => {
                  const active =
                    conversation?.codexSessionId === session.id ? " active" : "";
                  return `
                    <button class="session-picker-item${active}" type="button" data-session-id="${escapeHtml(session.id)}">
                      <span class="session-picker-title">${escapeHtml(session.threadName || "未命名 Session")}</span>
                      <span class="session-picker-meta">${escapeHtml(shortenId(session.id))} · ${escapeHtml(formatUpdatedAt(session.updatedAt))}</span>
                    </button>
                  `;
                })
                .join("")
            : '<div class="empty-inline">还没有可绑定的历史 Codex session。先在 Codex CLI 里跑过一次，或者发一条消息让它自动创建。</div>'
        }
      </div>
    </div>
  `;

  sessionPickerContent
    .querySelector("#session-close-button")
    ?.addEventListener("click", closeSessionPicker);

  sessionPickerContent.querySelectorAll("[data-session-id]").forEach((button) => {
    button.addEventListener("click", () => {
      const session = sessions.find((item) => item.id === button.dataset.sessionId);
      if (!session || !agent) {
        return;
      }

      requestOpenCodexSession(agent, session, fallbackWorkdir);
      closeSessionPicker();
    });
  });
}

function renderMessageToolbar(agent, conversation) {
  const messageCount = conversation?.messages?.length || 0;
  const lastMessage = getLastMessage(conversation);
  const statusText = state.messageViewport.showJumpButton
    ? "正在查看历史消息"
    : "跟随最新消息";
  const pills = [
    `运行时 ${getRuntimeLabel(agent)}`,
    `消息 ${messageCount} 条`,
    lastMessage ? `最近更新 ${formatUpdatedAt(lastMessage.createdAt)}` : "等待第一条消息",
    statusText,
  ];
  const hasCodexContext = agentUsesCodex(agent);

  if (hasCodexContext) {
    pills.splice(1, 0, `目录 ${conversation?.codexWorkdir || getAgentDefaultWorkdir(agent) || "未设置"}`);
    pills.splice(
      2,
      0,
      conversation?.codexSessionId
        ? `会话 ${shortenId(conversation.codexSessionId)}`
        : "首次回复后创建会话"
    );
  }

  messageToolbar.innerHTML = `
    ${pills
      .map((item) => `<span class="message-toolbar-pill">${escapeHtml(item)}</span>`)
      .join("")}
  `;
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
          <p class="muted">这个公网 AgentHub 受保护。输入 App Token 后，手机端才能查看会话并给数字员工发消息。</p>
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

function syncMessageViewportState() {
  const threshold = 36;
  const distanceToBottom =
    messagesNode.scrollHeight - messagesNode.scrollTop - messagesNode.clientHeight;
  const canScroll = messagesNode.scrollHeight > messagesNode.clientHeight + threshold;
  const stickToBottom = distanceToBottom <= threshold;

  state.messageViewport.stickToBottom = stickToBottom;
  state.messageViewport.showJumpButton = canScroll && !stickToBottom;

  messageStage.classList.toggle("show-jump-button", state.messageViewport.showJumpButton);
  messageJumpButton.hidden = !state.messageViewport.showJumpButton;
  renderMessageToolbar(getAgent(state.activeAgentId), getActiveConversation());
}

function scrollMessagesToBottom(behavior = "smooth") {
  messagesNode.scrollTo({
    top: messagesNode.scrollHeight,
    behavior,
  });
}

function renderMessages() {
  const agent = getAgent(state.activeAgentId);
  const conversation = getActiveConversation();
  const conversationId = conversation?.id || null;
  const currentMessageCount = conversation?.messages?.length || 0;
  const conversationChanged = state.messageViewport.lastConversationId !== conversationId;
  const shouldAutoStick = conversationChanged || state.messageViewport.stickToBottom;

  if (!state.activeAgentId || !agent) {
    conversationTitle.textContent = "等待 Agent";
    conversationSubtitle.textContent = "启动本机数字员工后，这里会显示它自己的会话和消息";
    renderThreadStrip(null);
    renderMessageToolbar(null, null);
    messagesNode.innerHTML =
      '<div class="empty-card">当前没有可用的数字员工。</div>';
    sendButton.disabled = true;
    messageJumpButton.hidden = true;
    messageStage.classList.remove("show-jump-button");
    return;
  }

  conversationTitle.textContent = conversation?.title || agent.name;

  if (!agent.online) {
    conversationSubtitle.textContent = "当前数字员工离线，新消息会先排队，等它重新连接后再投递";
  } else {
    conversationSubtitle.textContent = `已连接 · 当前数字员工运行时：${getRuntimeLabel(agent)}`;
  }

  renderThreadStrip(agent);
  renderMessageToolbar(agent, conversation);
  sendButton.disabled = !state.connected;

  if (!conversation || conversation.messages.length === 0) {
    messagesNode.innerHTML =
      '<div class="empty-card">还没有消息。发第一条消息试试看。</div>';
    state.messageViewport.lastConversationId = conversationId;
    state.messageViewport.lastMessageCount = 0;
    messageJumpButton.hidden = true;
    messageStage.classList.remove("show-jump-button");
    return;
  }

  messagesNode.innerHTML = conversation.messages
    .map((message) => {
      const roleClass = message.role === "assistant" ? "assistant" : "user";
      const statusLabel = STATUS_LABELS[message.status] || message.status || "";
      const status =
        message.role === "user" && statusLabel
          ? `<span class="status-tag status-${escapeHtml(message.status || "")}">${escapeHtml(statusLabel)}</span>`
          : "";
      const errorMessage =
        message.role === "user" && message.errorMessage
          ? `<div class="message-note error">${escapeHtml(message.errorMessage)}</div>`
          : "";
      return `
        <article class="message ${roleClass}">
          <div class="bubble">
            <p>${escapeHtml(message.text).replaceAll("\n", "<br />")}</p>
          </div>
          <div class="meta">
            <span>${formatTime(message.createdAt)}</span>
            ${status}
          </div>
          ${errorMessage}
        </article>
      `;
    })
    .join("");

  const latestPending = [...conversation.messages]
    .reverse()
    .find(
      (message) =>
        message.role === "user" &&
        ["queued", "sent", "processing"].includes(message.status)
    );

  if (latestPending?.status === "processing") {
    messagesNode.innerHTML += `
      <article class="message assistant transient">
        <div class="bubble typing-bubble">
          <span></span><span></span><span></span>
        </div>
        <div class="meta">
          <span>数字员工正在处理</span>
        </div>
      </article>
    `;
  }

  requestAnimationFrame(() => {
    if (shouldAutoStick) {
      scrollMessagesToBottom(conversationChanged ? "auto" : "smooth");
    }
    syncMessageViewportState();
  });

  state.messageViewport.lastConversationId = conversationId;
  state.messageViewport.lastMessageCount = currentMessageCount;
}

function renderDirectoryPicker() {
  const picker = state.directoryPicker;
  if (!picker.open) {
    directoryPickerModal.hidden = true;
    directoryPickerContent.innerHTML = "";
    return;
  }

  const agent = getAgent(picker.agentId);
  const disabled = !state.connected || !agent?.online;
  const roots = picker.roots || [];
  const entries = picker.entries || [];

  directoryPickerModal.hidden = false;
  directoryPickerContent.innerHTML = `
    <div class="directory-modal-card">
      <div class="directory-modal-head">
        <div>
          <h3>选择 Codex 工作目录</h3>
          <p class="muted">这个目录会绑定到新线程，后续这个线程里的 Codex 回复都会尽量在这里工作。</p>
        </div>
        <button class="directory-close-button" id="directory-close-button" type="button">关闭</button>
      </div>

      <label class="directory-field">
        <span>目录路径</span>
        <input id="directory-path-input" value="${escapeHtml(picker.inputPath)}" placeholder="/Users/zhangpeng/project" />
      </label>

      <div class="directory-actions">
        <button type="button" class="directory-action-button" id="directory-browse-button" ${disabled ? "disabled" : ""}>读取目录</button>
        <button type="button" class="directory-action-button" id="directory-parent-button" ${disabled || !picker.parentPath ? "disabled" : ""}>上一级</button>
        <button type="button" class="directory-action-button" id="directory-default-button" ${disabled ? "disabled" : ""}>默认目录</button>
      </div>

      <div class="directory-roots">
        ${(roots.length > 0
          ? roots
              .map(
                (root) => `
                  <button type="button" class="directory-root-chip${root === picker.currentPath ? " active" : ""}" data-root-path="${escapeHtml(root)}" ${disabled ? "disabled" : ""}>
                    ${escapeHtml(root)}
                  </button>
                `
              )
              .join("")
          : '<span class="muted-text">当前数字员工没有暴露可浏览根目录。</span>')}
      </div>

      <div class="directory-browser">
        <div class="directory-browser-head">
          <span>当前目录</span>
          <code>${escapeHtml(picker.currentPath || picker.inputPath || "未选择")}</code>
        </div>
        <div class="directory-browser-list">
          ${
            picker.loading
              ? '<div class="directory-loading">正在读取目录...</div>'
              : picker.error
                ? `<div class="directory-error">${escapeHtml(picker.error)}</div>`
                : entries.length > 0
                  ? entries
                      .map(
                        (entry) => `
                          <button type="button" class="directory-entry" data-entry-path="${escapeHtml(entry.path)}" ${disabled ? "disabled" : ""}>
                            <span class="directory-entry-title">${escapeHtml(entry.name)}</span>
                            <span class="directory-entry-path">${escapeHtml(entry.path)}</span>
                          </button>
                        `
                      )
                      .join("")
                  : '<div class="directory-empty">这个目录下没有可继续进入的子目录。</div>'
          }
        </div>
      </div>

      <div class="directory-modal-foot">
        <button type="button" class="directory-secondary-button" id="directory-cancel-button">取消</button>
        <button type="button" class="directory-primary-button" id="directory-confirm-button" ${disabled ? "disabled" : ""}>创建 Codex 线程</button>
      </div>
    </div>
  `;

  directoryPickerContent
    .querySelector("#directory-close-button")
    ?.addEventListener("click", closeDirectoryPicker);
  directoryPickerContent
    .querySelector("#directory-cancel-button")
    ?.addEventListener("click", closeDirectoryPicker);

  const input = directoryPickerContent.querySelector("#directory-path-input");
  input?.addEventListener("input", (event) => {
    state.directoryPicker.inputPath = event.target.value;
  });

  directoryPickerContent
    .querySelector("#directory-browse-button")
    ?.addEventListener("click", () =>
      requestDirectoryList(picker.agentId, state.directoryPicker.inputPath)
    );

  directoryPickerContent
    .querySelector("#directory-parent-button")
    ?.addEventListener("click", () =>
      requestDirectoryList(picker.agentId, picker.parentPath)
    );

  directoryPickerContent
    .querySelector("#directory-default-button")
    ?.addEventListener("click", () => {
      const defaultPath = getAgentDefaultWorkdir(agent);
      state.directoryPicker.inputPath = defaultPath;
      renderDirectoryPicker();
      requestDirectoryList(picker.agentId, defaultPath);
    });

  directoryPickerContent.querySelectorAll("[data-root-path]").forEach((button) => {
    button.addEventListener("click", () =>
      requestDirectoryList(picker.agentId, button.dataset.rootPath)
    );
  });

  directoryPickerContent.querySelectorAll("[data-entry-path]").forEach((button) => {
    button.addEventListener("click", () =>
      requestDirectoryList(picker.agentId, button.dataset.entryPath)
    );
  });

  directoryPickerContent
    .querySelector("#directory-confirm-button")
    ?.addEventListener("click", () => {
      const workdir = state.directoryPicker.inputPath.trim() || getAgentDefaultWorkdir(agent);
      requestNewCodexConversation(picker.agentId, workdir);
      closeDirectoryPicker();
    });
}

function renderConnection() {
  socketDot.classList.toggle("online", state.connected);
  socketText.textContent = state.connected
    ? "已连接"
    : state.auth.promptOpen
      ? "等待令牌"
      : "连接中断";
}

function render() {
  ensureActiveSelection();
  renderConnection();
  renderAgents();
  renderMessages();
  renderDirectoryPicker();
  renderSessionPicker();
  renderAuthPrompt();
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
      state.conversations = payload.data.conversations || [];
      render();
      return;
    }

    if (payload.type === "conversation_opened" && payload.conversationId) {
      state.pendingConversationId = payload.conversationId;
      const conversation = state.conversations.find(
        (item) => item.id === payload.conversationId
      );
      if (conversation) {
        state.activeAgentId = conversation.agentId;
        state.activeConversationId = conversation.id;
        state.pendingConversationId = null;
        render();
      }
      return;
    }

    if (payload.type === "agent_directory_list") {
      handleDirectoryList(payload);
      return;
    }

    if (payload.type === "error" && payload.message) {
      console.error(payload.message);
    }
  });
}

composer.addEventListener("submit", (event) => {
  event.preventDefault();

  const text = messageInput.value.trim();
  if (!text || !state.activeAgentId || !state.socket || state.socket.readyState !== 1) {
    return;
  }

  sendAction({
    type: "user_message",
    agentId: state.activeAgentId,
    conversationId: state.activeConversationId,
    text,
  });

  messageInput.value = "";
  messageInput.focus();
});

messageInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    composer.requestSubmit();
  }
});

directoryPickerModal.addEventListener("click", (event) => {
  if (event.target === directoryPickerModal) {
    closeDirectoryPicker();
  }
});

sessionPickerModal.addEventListener("click", (event) => {
  if (event.target === sessionPickerModal) {
    closeSessionPicker();
  }
});

messagesNode.addEventListener("scroll", () => {
  syncMessageViewportState();
});

messageJumpButton.addEventListener("click", () => {
  scrollMessagesToBottom();
});

updateViewportHeight();
window.addEventListener("resize", updateViewportHeight);
window.addEventListener("orientationchange", updateViewportHeight);
window.visualViewport?.addEventListener("resize", updateViewportHeight);
window.visualViewport?.addEventListener("scroll", updateViewportHeight);

connect();
