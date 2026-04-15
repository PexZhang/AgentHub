const UI_PREFS_KEY = "agenthub-ui-prefs-v2";
const APP_TOKEN_STORAGE_KEY = "agenthub-app-token-v1";
const launchParams = new URLSearchParams(window.location.search);

function buildDefaultUiState() {
  return {
    threadsCollapsed: window.matchMedia("(max-width: 720px)").matches,
    mobileView: "devices",
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
  devices: [],
  agents: [],
  tasks: [],
  conversations: [],
  manager: {
    messages: [],
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
  activeDeviceId: null,
  activeAgentId: null,
  activeConversationId: null,
  pendingConversationId: null,
  directFocus: null,
  ui: loadUiState(),
  messageViewport: {
    stickToBottom: true,
    showJumpButton: false,
    lastConversationId: null,
    lastMessageCount: 0,
    lastRenderSignature: "",
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
  launchTarget: {
    agentId: launchParams.get("agentId") || null,
    conversationId: launchParams.get("conversationId") || null,
    agentName: launchParams.get("agentName") || null,
    deviceName: launchParams.get("deviceName") || null,
    applied: false,
  },
};

const socketDot = document.querySelector("#socket-dot");
const socketText = document.querySelector("#socket-text");
const shellNode = document.querySelector(".shell");
const managerSubtitle = document.querySelector("#manager-subtitle");
const managerProvider = document.querySelector("#manager-provider");
const managerSummary = document.querySelector("#manager-summary");
const managerQuickActions = document.querySelector("#manager-quick-actions");
const managerStage = document.querySelector("#manager-stage");
const managerMessagesNode = document.querySelector("#manager-messages");
const managerComposer = document.querySelector("#manager-composer");
const managerInput = document.querySelector("#manager-input");
const managerSendButton = document.querySelector("#manager-send-button");
const agentCount = document.querySelector("#agent-count");
const deviceList = document.querySelector("#device-list");
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
const mobileNav = document.querySelector("#mobile-nav");

const STATUS_LABELS = {
  queued: "排队中",
  sent: "已发送",
  processing: "处理中",
  answered: "已完成",
  failed: "失败",
};
const DIRECTORY_REQUEST_TIMEOUT_MS = 4000;
const MANAGER_QUICK_ACTIONS = [
  "现在我的 agent 员工有哪些",
  "他们现在在做什么",
  "谁卡住了",
  "看看最新任务进度",
];

function updateViewportHeight() {
  const viewportHeight = window.visualViewport?.height || window.innerHeight;
  document.documentElement.style.setProperty("--app-height", `${Math.round(viewportHeight)}px`);
}

function isMobileLayout() {
  return window.matchMedia("(max-width: 720px)").matches;
}

function setMobileView(view, options = {}) {
  const nextView = ["devices", "threads", "chat"].includes(view) ? view : "devices";
  state.ui.mobileView = nextView;

  if (!options.skipPersist) {
    persistUiState();
  }
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

function getDevice(deviceId) {
  return state.devices.find((device) => device.id === deviceId) || null;
}

function getManagerStatusLabel(message) {
  return STATUS_LABELS[message?.status] || message?.status || "";
}

function deriveDevicesFromAgents(agents) {
  const deviceMap = new Map();

  for (const agent of agents || []) {
    const deviceId = String(agent.deviceId || "default-device");
    const current = deviceMap.get(deviceId) || {
      id: deviceId,
      name: String(agent.deviceName || "当前设备"),
      online: false,
      agentCount: 0,
      onlineAgentCount: 0,
      lastSeenAt: null,
    };

    current.agentCount += 1;
    if (agent.online) {
      current.online = true;
      current.onlineAgentCount += 1;
    }

    if (!current.lastSeenAt || new Date(agent.lastSeenAt || 0) > new Date(current.lastSeenAt || 0)) {
      current.lastSeenAt = agent.lastSeenAt || current.lastSeenAt;
    }

    deviceMap.set(deviceId, current);
  }

  return [...deviceMap.values()].sort((left, right) => {
    if (left.online !== right.online) {
      return left.online ? -1 : 1;
    }
    return left.name.localeCompare(right.name);
  });
}

function getAgentsForDevice(deviceId) {
  return state.agents
    .filter((agent) => !deviceId || agent.deviceId === deviceId)
    .sort((left, right) => {
      if (left.online !== right.online) {
        return left.online ? -1 : 1;
      }
      return left.name.localeCompare(right.name);
    });
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

function ensureMobileView() {
  if (!["devices", "threads", "chat"].includes(state.ui.mobileView)) {
    state.ui.mobileView = "devices";
  }

  if (!isMobileLayout()) {
    return;
  }

  if (!state.activeAgentId) {
    state.ui.mobileView = "devices";
    return;
  }

  if (!state.activeConversationId && state.ui.mobileView === "chat") {
    state.ui.mobileView = "threads";
  }
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

function selectDevice(deviceId) {
  state.pendingConversationId = null;
  state.activeDeviceId = deviceId;
  const agents = getAgentsForDevice(deviceId);
  const activeAgentInDevice = agents.some((agent) => agent.id === state.activeAgentId);

  if (!activeAgentInDevice) {
    state.activeAgentId = agents[0]?.id || null;
    state.activeConversationId = null;
  }
}

function selectAgent(agentId) {
  state.pendingConversationId = null;
  if (state.directFocus && state.directFocus.agentId !== agentId) {
    state.directFocus = null;
  }
  state.activeAgentId = agentId;
  state.activeDeviceId = getAgent(agentId)?.deviceId || state.activeDeviceId;
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
      state.activeDeviceId =
        getAgent(pendingConversation.agentId)?.deviceId ||
        pendingConversation.deviceId ||
        state.activeDeviceId;
      state.pendingConversationId = null;
      return;
    }

    return;
  }

  const activeConversation = getActiveConversation();
  if (activeConversation) {
    state.activeAgentId = activeConversation.agentId;
    state.activeDeviceId =
      getAgent(activeConversation.agentId)?.deviceId ||
      activeConversation.deviceId ||
      state.activeDeviceId;
  }

  if (
    state.activeAgentId &&
    state.agents.some((agent) => agent.id === state.activeAgentId)
  ) {
    state.activeDeviceId =
      getAgent(state.activeAgentId)?.deviceId || state.activeDeviceId;
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

  if (
    state.activeDeviceId &&
    state.devices.some((device) => device.id === state.activeDeviceId)
  ) {
    const deviceAgents = getAgentsForDevice(state.activeDeviceId);
    if (deviceAgents[0]) {
      selectAgent(deviceAgents[0].id);
      return;
    }
  }

  const onlineDevice = state.devices.find((device) => device.online);
  const fallbackDevice = onlineDevice?.id || state.devices[0]?.id || null;
  if (!fallbackDevice) {
    const onlineAgent = state.agents.find((agent) => agent.online);
    const fallbackAgent = onlineAgent?.id || state.agents[0]?.id || null;
    if (!fallbackAgent) {
      state.activeDeviceId = null;
      state.activeAgentId = null;
      state.activeConversationId = null;
      return;
    }

    selectAgent(fallbackAgent);
    return;
  }

  state.activeDeviceId = fallbackDevice;
  const fallbackAgent = getAgentsForDevice(fallbackDevice)[0]?.id || null;
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

function openDirectConversation(action) {
  if (!action?.agentId) {
    return;
  }

  state.directFocus = {
    agentId: action.agentId,
    conversationId: action.conversationId || null,
    agentName: action.agentName || getAgent(action.agentId)?.name || action.agentId,
    deviceName:
      action.deviceName || getAgent(action.agentId)?.deviceName || getDevice(state.activeDeviceId)?.name,
  };
  selectAgent(action.agentId);
  if (action.conversationId) {
    state.activeConversationId = action.conversationId;
  }
  if (isMobileLayout()) {
    setMobileView("chat", { skipPersist: true });
  }
  render();
  requestAnimationFrame(() => {
    document.querySelector(".conversation-panel")?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  });
}

function openManagerAction(action) {
  if (!action?.type) {
    return;
  }

  if (action.type === "switch_direct") {
    openDirectConversation(action);
    return;
  }

  if (action.type === "open_task_detail" && action.taskId) {
    const params = new URLSearchParams();
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
    window.location.href = `/task.html?${params.toString()}`;
  }
}

function applyLaunchTarget() {
  if (state.launchTarget.applied || !state.launchTarget.agentId) {
    return;
  }

  const agent = getAgent(state.launchTarget.agentId);
  if (!agent) {
    return;
  }

  state.launchTarget.applied = true;
  state.directFocus = {
    agentId: state.launchTarget.agentId,
    conversationId: state.launchTarget.conversationId || null,
    agentName: state.launchTarget.agentName || agent.name,
    deviceName: state.launchTarget.deviceName || agent.deviceName,
  };
  selectAgent(state.launchTarget.agentId);

  if (state.launchTarget.conversationId) {
    state.activeConversationId = state.launchTarget.conversationId;
  }

  if (isMobileLayout()) {
    setMobileView("chat", { skipPersist: true });
  }
}

function renderManagerPanel() {
  if (
    !managerProvider ||
    !managerSubtitle ||
    !managerSummary ||
    !managerQuickActions ||
    !managerMessagesNode ||
    !managerSendButton ||
    !managerComposer ||
    !managerInput
  ) {
    return;
  }

  const summary = state.manager.summary || {};
  const providerLabel =
    state.manager.provider === "openai"
      ? `大模型 ${state.manager.model || "OpenAI"}`
      : "本地摘要";
  managerProvider.textContent = providerLabel;
  managerSubtitle.textContent =
    state.manager.provider === "openai"
      ? "告诉我你想推进什么任务，我会先理解、再调度员工，必要时帮你切到直连。"
      : "当前还没配置经理层大模型，我先用本地摘要能力帮你盘点员工和任务。";

  managerSummary.innerHTML = `
    <div class="manager-stat-card">
      <span class="manager-stat-label">在线员工</span>
      <strong>${summary.onlineAgentCount || 0}/${summary.totalAgentCount || 0}</strong>
    </div>
    <div class="manager-stat-card">
      <span class="manager-stat-label">执行中任务</span>
      <strong>${summary.activeTaskCount || 0}</strong>
    </div>
    <div class="manager-stat-card">
      <span class="manager-stat-label">阻塞任务</span>
      <strong>${summary.blockedTaskCount || 0}</strong>
    </div>
  `;

  managerQuickActions.innerHTML = MANAGER_QUICK_ACTIONS.map(
    (text) => `
      <button type="button" class="manager-quick-button" data-manager-prompt="${escapeHtml(text)}">
        ${escapeHtml(text)}
      </button>
    `
  ).join("");

  managerQuickActions.querySelectorAll("[data-manager-prompt]").forEach((button) => {
    button.addEventListener("click", () => {
      managerInput.value = button.dataset.managerPrompt || "";
      managerComposer.requestSubmit();
    });
  });

  const messages = state.manager.messages || [];
  if (messages.length === 0) {
    managerMessagesNode.innerHTML = `
      <div class="empty-card manager-empty-card">
        先直接问我，例如“现在我的员工有哪些”“他们现在在做什么”“帮我切到和 Codex Main 的对话”。
      </div>
    `;
  } else {
    managerMessagesNode.innerHTML = messages
      .map((message) => {
        const roleClass = message.role === "assistant" ? "assistant" : "user";
        const statusLabel = message.role === "user" ? getManagerStatusLabel(message) : "";
        const statusMarkup = statusLabel
          ? `<span class="status-tag status-${escapeHtml(message.status || "")}">${escapeHtml(statusLabel)}</span>`
          : "";
        const errorMarkup =
          message.role === "user" && message.errorMessage
            ? `<div class="message-note error">${escapeHtml(message.errorMessage)}</div>`
            : "";
        const actionMarkup =
          message.role === "assistant" && message.action?.type
            ? `
              <div class="manager-action-row">
                <button
                  type="button"
                  class="manager-action-button"
                  data-manager-action="${encodeURIComponent(JSON.stringify(message.action))}"
                >
                  ${escapeHtml(
                    message.action.label ||
                      (message.action.type === "open_task_detail"
                        ? "查看任务详情"
                        : `进入与 ${message.action.agentName || message.action.agentId} 的直连`)
                  )}
                </button>
              </div>
            `
            : "";

        return `
          <article class="message ${roleClass}">
            <div class="bubble">
              <p>${escapeHtml(message.text).replaceAll("\n", "<br />")}</p>
            </div>
            <div class="meta">
              <span>${formatTime(message.createdAt)}</span>
              ${statusMarkup}
            </div>
            ${actionMarkup}
            ${errorMarkup}
          </article>
        `;
      })
      .join("");

    const latestPending = [...messages]
      .reverse()
      .find(
        (message) =>
          message.role === "user" &&
          ["queued", "sent", "processing"].includes(message.status)
      );

    if (latestPending?.status === "processing") {
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

  managerSendButton.disabled = !state.connected;
  requestAnimationFrame(() => {
    managerMessagesNode.scrollTo({
      top: managerMessagesNode.scrollHeight,
      behavior: "smooth",
    });
  });
}

function renderDevices() {
  const devices = state.devices.length > 0 ? state.devices : deriveDevicesFromAgents(state.agents);

  if (devices.length === 0) {
    deviceList.innerHTML = "";
    return;
  }

  deviceList.innerHTML = devices
    .map((device) => {
      const activeClass = device.id === state.activeDeviceId ? " active" : "";
      return `
        <button class="device-chip${activeClass}" data-device-id="${escapeHtml(device.id)}" type="button">
          <span class="device-chip-title">${escapeHtml(device.name)}</span>
          <span class="device-chip-meta">
            ${device.online ? "在线" : "离线"} · ${device.onlineAgentCount || 0}/${device.agentCount || 0} 个数字员工
          </span>
        </button>
      `;
    })
    .join("");

  deviceList.querySelectorAll("[data-device-id]").forEach((button) => {
    button.addEventListener("click", () => {
      selectDevice(button.dataset.deviceId);
      if (isMobileLayout()) {
        setMobileView("devices");
      }
      render();
    });
  });
}

function renderAgents() {
  const visibleAgents = getAgentsForDevice(state.activeDeviceId);
  const onlineAgentCount = state.agents.filter((agent) => agent.online).length;
  agentCount.textContent = `${state.devices.length || deriveDevicesFromAgents(state.agents).length} 台设备 · ${onlineAgentCount} 个在线数字员工`;

  if (state.agents.length === 0) {
    deviceList.innerHTML = "";
    agentList.innerHTML =
      '<div class="empty-card">还没有 Agent 连上来。先运行本地 Agent，再从手机打开这个页面。</div>';
    return;
  }

  renderDevices();

  if (visibleAgents.length === 0) {
    agentList.innerHTML =
      '<div class="empty-card">这台设备下还没有数字员工。连上第二台电脑后，这里会显示它的 Agent。</div>';
    return;
  }

  agentList.innerHTML = visibleAgents
    .map((agent) => {
      const activeClass = agent.id === state.activeAgentId ? " active" : "";
      const offlineClass = agent.online ? "" : " offline";
      return `
        <button class="agent-chip${activeClass}${offlineClass}" data-agent-id="${escapeHtml(agent.id)}">
          <span class="agent-chip-title">${escapeHtml(agent.name)}</span>
          <span class="agent-chip-meta">
            ${agent.online ? "在线" : "离线"} · ${escapeHtml(agent.deviceName || "当前设备")} · 运行时 ${escapeHtml(getRuntimeLabel(agent))}
          </span>
        </button>
      `;
    })
    .join("");

  agentList.querySelectorAll("[data-agent-id]").forEach((button) => {
    button.addEventListener("click", () => {
      selectAgent(button.dataset.agentId);
      if (isMobileLayout()) {
        setMobileView("threads");
      }
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
  const forceExpanded = isMobileLayout() && state.ui.mobileView === "threads";
  const collapsed = forceExpanded ? false : state.ui.threadsCollapsed;
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
        <span class="section-toggle-state">${forceExpanded ? "线程页" : collapsed ? "展开" : "收起"}</span>
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

  if (!forceExpanded) {
    threadStrip.querySelector("#thread-toggle-button")?.addEventListener("click", () => {
      toggleUiPanel("threadsCollapsed");
    });
  }

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
      if (state.directFocus && state.directFocus.agentId !== agent.id) {
        state.directFocus = null;
      }
      if (isMobileLayout()) {
        setMobileView("chat");
      }
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

function renderMobileNav() {
  if (!isMobileLayout()) {
    mobileNav.hidden = true;
    mobileNav.innerHTML = "";
    shellNode.dataset.mobileView = "desktop";
    return;
  }

  ensureMobileView();
  shellNode.dataset.mobileView = state.ui.mobileView;

  const activeAgent = getAgent(state.activeAgentId);
  const activeConversation = getActiveConversation();
  const items = [
    {
      id: "devices",
      label: "设备",
      meta: `${state.devices.length || deriveDevicesFromAgents(state.agents).length} 台设备`,
      disabled: false,
    },
    {
      id: "threads",
      label: "线程",
      meta: activeAgent ? activeAgent.name : "先选数字员工",
      disabled: !activeAgent,
    },
    {
      id: "chat",
      label: "聊天",
      meta: activeConversation?.title || "先选线程",
      disabled: !activeConversation,
    },
  ];

  mobileNav.hidden = false;
  mobileNav.innerHTML = items
    .map((item) => {
      const activeClass = item.id === state.ui.mobileView ? " active" : "";
      const disabledAttr = item.disabled ? " disabled" : "";
      return `
        <button
          type="button"
          class="mobile-nav-button${activeClass}"
          data-mobile-view="${escapeHtml(item.id)}"
          ${disabledAttr}
        >
          <span class="mobile-nav-label">${escapeHtml(item.label)}</span>
          <span class="mobile-nav-meta">${escapeHtml(item.meta)}</span>
        </button>
      `;
    })
    .join("");

  mobileNav.querySelectorAll("[data-mobile-view]").forEach((button) => {
    button.addEventListener("click", () => {
      if (button.disabled) {
        return;
      }

      setMobileView(button.dataset.mobileView);
      render();
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
    `设备 ${(agent && (agent.deviceName || getDevice(agent.deviceId)?.name)) || "未选择"}`,
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

function buildConversationRenderSignature(conversationId, messages, hiddenMessageCount, showTyping) {
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

function renderMessages() {
  const agent = getAgent(state.activeAgentId);
  const conversation = getActiveConversation();
  const conversationId = conversation?.id || null;
  const currentMessageCount = conversation?.messages?.length || 0;
  const conversationChanged = state.messageViewport.lastConversationId !== conversationId;
  const shouldAutoStick = conversationChanged || state.messageViewport.stickToBottom;

  if (!state.activeAgentId || !agent) {
    conversationTitle.textContent = "等待直连员工";
    conversationSubtitle.textContent = "AI经理 会在需要时把你切到这里，直接和某位数字员工对话。";
    renderThreadStrip(null);
    renderMessageToolbar(null, null);
    messagesNode.innerHTML =
      '<div class="empty-card">当前没有可用的数字员工。</div>';
    sendButton.disabled = true;
    messageJumpButton.hidden = true;
    messageStage.classList.remove("show-jump-button");
    return;
  }

  const deviceName =
    agent.deviceName || conversation?.deviceName || getDevice(agent.deviceId)?.name || "当前设备";
  const mobileThreadsView = isMobileLayout() && state.ui.mobileView === "threads";

  conversationTitle.textContent = mobileThreadsView ? agent.name : conversation?.title || agent.name;

  if (mobileThreadsView) {
    conversationSubtitle.textContent = `设备 ${deviceName} · ${getConversationsForAgent(agent.id).length} 个线程 · 当前数字员工运行时：${getRuntimeLabel(agent)}`;
  } else if (!agent.online) {
    conversationSubtitle.textContent = `设备 ${deviceName} · 当前数字员工离线，新消息会先排队，等它重新连接后再投递`;
  } else {
    const directPrefix =
      state.directFocus?.agentId === agent.id
        ? `当前直连 ${state.directFocus.agentName || agent.name} · `
        : "";
    conversationSubtitle.textContent = `${directPrefix}设备 ${deviceName} · 当前数字员工运行时：${getRuntimeLabel(agent)}`;
  }

  renderThreadStrip(agent);
  renderMessageToolbar(agent, conversation);
  sendButton.disabled = !state.connected;

  if (!conversation || conversation.messages.length === 0) {
    state.messageViewport.lastRenderSignature = buildConversationRenderSignature(
      conversationId,
      [],
      0,
      false
    );
    messagesNode.innerHTML =
      '<div class="empty-card">还没有消息。发第一条消息试试看。</div>';
    state.messageViewport.lastConversationId = conversationId;
    state.messageViewport.lastMessageCount = 0;
    messageJumpButton.hidden = true;
    messageStage.classList.remove("show-jump-button");
    return;
  }

  const hiddenMessageCount = conversation.hiddenMessageCount || 0;
  const lastMessage = conversation.messages[conversation.messages.length - 1] || null;
  const shouldShowTyping =
    lastMessage?.role === "user" &&
    ["queued", "sent", "processing"].includes(lastMessage.status);
  const renderSignature = buildConversationRenderSignature(
    conversationId,
    conversation.messages,
    hiddenMessageCount,
    shouldShowTyping
  );

  if (renderSignature !== state.messageViewport.lastRenderSignature) {
    const historyNotice =
      hiddenMessageCount > 0
        ? `
          <div class="message-history-note">
            为保持页面流畅，这里只显示最近 ${conversation.messages.length} 条直连消息，已折叠更早的 ${hiddenMessageCount} 条。
          </div>
        `
        : "";

    messagesNode.innerHTML =
      historyNotice +
      conversation.messages
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

    if (shouldShowTyping) {
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

    state.messageViewport.lastRenderSignature = renderSignature;
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
  applyLaunchTarget();
  ensureMobileView();
  renderConnection();
  renderManagerPanel();
  renderMobileNav();
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
      state.devices = payload.data.devices || deriveDevicesFromAgents(payload.data.agents || []);
      state.agents = payload.data.agents || [];
      state.tasks = payload.data.tasks || [];
      state.conversations = payload.data.conversations || [];
      state.manager = payload.data.manager || state.manager;
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
        state.activeDeviceId =
          getAgent(conversation.agentId)?.deviceId ||
          conversation.deviceId ||
          state.activeDeviceId;
        state.activeConversationId = conversation.id;
        state.pendingConversationId = null;
        if (isMobileLayout()) {
          setMobileView("chat", { skipPersist: true });
        }
        render();
      }
      return;
    }

    if (payload.type === "agent_directory_list") {
      handleDirectoryList(payload);
      return;
    }

    if (
      (payload.type === "manager_action_requested" || payload.type === "manager_direct_opened") &&
      payload.action
    ) {
      openManagerAction(payload.action);
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

if (managerComposer && managerInput) {
  managerComposer.addEventListener("submit", (event) => {
    event.preventDefault();

    const text = managerInput.value.trim();
    if (!text || !state.socket || state.socket.readyState !== 1) {
      return;
    }

    sendAction({
      type: "manager_message",
      text,
    });

    managerInput.value = "";
    managerInput.focus();
  });
}

messageInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    composer.requestSubmit();
  }
});

if (managerInput && managerComposer) {
  managerInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      managerComposer.requestSubmit();
    }
  });
}

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
