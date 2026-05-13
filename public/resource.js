import { fetchAuthenticatedSnapshot, installSnapshotRecovery } from "./live-state.js";

const APP_TOKEN_STORAGE_KEY = "agenthub-app-token-v1";

const route = (() => {
  const params = new URLSearchParams(window.location.search);
  return {
    resourceId: params.get("resourceId") || "",
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
  resource: null,
  content: {
    mode: "head",
    text: "",
    loading: false,
    error: "",
  },
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
const resourceShell = document.querySelector("#resource-shell");
const resourcePageSubtitle = document.querySelector("#resource-page-subtitle");
const resourceTitle = document.querySelector("#resource-title");
const resourceSubtitle = document.querySelector("#resource-subtitle");
const resourceStatusBadges = document.querySelector("#resource-status-badges");
const resourceMetaGrid = document.querySelector("#resource-meta-grid");
const resourcePreview = document.querySelector("#resource-preview");
const resourceContentTitle = document.querySelector("#resource-content-title");
const resourceContent = document.querySelector("#resource-content");
const resourceActions = document.querySelector("#resource-actions");
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

function formatFileSize(bytes) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) {
    return "0 B";
  }

  if (value < 1024) {
    return `${value} B`;
  }

  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(value >= 10 * 1024 ? 0 : 1)} KB`;
  }

  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function compactResourceName(value) {
  const text = String(value || "").trim();
  if (text.length <= 18) {
    return text;
  }

  const dotIndex = text.lastIndexOf(".");
  const suffix = dotIndex > 0 ? text.slice(dotIndex) : "";
  const headLength = Math.max(10, 18 - suffix.length - 3);
  return `${text.slice(0, headLength)}...${suffix}`;
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

async function fetchJson(pathValue) {
  const response = await fetch(pathValue, {
    headers: {
      Authorization: `Bearer ${state.auth.token || ""}`,
    },
    cache: "no-store",
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.ok === false) {
    const error = new Error(data?.message || "请求失败");
    error.authRequired = response.status === 401 || data?.error === "UNAUTHORIZED";
    throw error;
  }

  return data;
}

async function loadResourceContent(mode = state.content.mode) {
  if (!route.resourceId || state.auth.blocked) {
    return;
  }

  state.content.loading = true;
  state.content.error = "";
  state.content.mode = mode;
  renderResourceView();

  try {
    const result = await fetchJson(
      `/api/resources/${encodeURIComponent(route.resourceId)}/content?mode=${encodeURIComponent(
        mode
      )}&limitLines=120`
    );
    state.content.text = normalizeText(result?.content);
    state.content.error = "";
  } catch (error) {
    if (error.authRequired) {
      state.connected = false;
      clearAuthToken();
      openAuthPrompt(error.message || "访问令牌无效，请重新输入。");
    } else {
      state.content.error = error.message || "读取资源内容失败。";
    }
  } finally {
    state.content.loading = false;
    renderResourceView();
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
    renderResourceView();
    return false;
  }

  if (!result.ok) {
    return false;
  }

  state.snapshot = result.data || null;
  state.resource =
    (state.snapshot?.resources || []).find((resource) => resource.id === route.resourceId) || null;
  state.auth.promptOpen = false;
  state.auth.blocked = false;
  state.auth.error = "";

  if (route.resourceId) {
    await loadResourceContent(state.content.mode);
  }

  renderResourceView();
  return true;
}

function renderAuthPrompt() {
  if (resourceShell) {
    resourceShell.hidden = state.auth.promptOpen;
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
          <p class="muted">确认后，我再继续加载资源状态、关联任务和正文摘录。</p>
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

function buildTaskHref(resource) {
  const taskId = route.taskId || resource?.primaryTaskId;
  if (!taskId) {
    return "";
  }

  const params = new URLSearchParams();
  params.set("taskId", taskId);
  if (route.conversationId || resource?.sourceConversationId) {
    params.set("conversationId", route.conversationId || resource?.sourceConversationId);
  }
  if (route.agentId || resource?.primaryAgentId) {
    params.set("agentId", route.agentId || resource?.primaryAgentId);
  }
  if (route.agentName || resource?.primaryAgentName) {
    params.set("agentName", route.agentName || resource?.primaryAgentName);
  }
  if (route.deviceName) {
    params.set("deviceName", route.deviceName);
  }

  return `/task.html?${params.toString()}`;
}

function buildDirectHref(resource) {
  const agentId = route.agentId || resource?.primaryAgentId;
  if (!agentId) {
    return "";
  }

  const params = new URLSearchParams();
  params.set("agentId", agentId);
  if (route.conversationId || resource?.sourceConversationId) {
    params.set("conversationId", route.conversationId || resource?.sourceConversationId);
  }
  if (route.agentName || resource?.primaryAgentName) {
    params.set("agentName", route.agentName || resource?.primaryAgentName);
  }
  if (route.deviceName) {
    params.set("deviceName", route.deviceName);
  }

  return `/direct.html?${params.toString()}`;
}

function renderStatusBadges(resource) {
  const badges = [
    {
      tone: resource?.active ? "active" : resource?.orphaned ? "blocked" : "idle",
      label: resource?.statusLabel || "未知状态",
    },
  ];

  if (resource?.workspaceName) {
    badges.push({
      tone: "idle",
      label: resource.workspaceName,
    });
  }

  return badges
    .map(
      (item) =>
        `<span class="task-status-pill ${escapeHtml(item.tone)}">${escapeHtml(item.label)}</span>`
    )
    .join("");
}

function renderActions(resource) {
  if (!resource) {
    resourceActions.innerHTML = `
      <article class="task-jump-card">
        <div class="task-jump-copy">
          <strong>回到 AI经理</strong>
          <p>当前没有找到这份资源，建议回到经理页或任务页重新定位。</p>
        </div>
        <div class="actions">
          <a class="ghost-btn" href="/">返回首页</a>
        </div>
      </article>
    `;
    return;
  }

  const directHref = buildDirectHref(resource);
  const taskHref = buildTaskHref(resource);

  resourceActions.innerHTML = `
    <article class="task-jump-card">
      <div class="task-jump-copy">
        <strong>下一步</strong>
        <p>需要继续分析这份内容时，直接回到员工会话里追问。</p>
      </div>
      <div class="actions resource-actions-row">
        ${directHref ? `<a class="primary-btn" href="${escapeHtml(directHref)}">回到会话</a>` : ""}
        <button
          type="button"
          class="ghost-btn"
          data-resource-mode="head"
          ${state.content.mode === "head" ? 'aria-current="true"' : ""}
        >
          查看头部
        </button>
        <button
          type="button"
          class="ghost-btn"
          data-resource-mode="tail"
          ${state.content.mode === "tail" ? 'aria-current="true"' : ""}
        >
          查看尾部
        </button>
        ${taskHref ? `<a class="ghost-btn" href="${escapeHtml(taskHref)}">会话入口</a>` : ""}
      </div>
    </article>
  `;

  resourceActions.querySelectorAll("[data-resource-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      const nextMode = button.dataset.resourceMode || "head";
      if (nextMode === state.content.mode && !state.content.error) {
        return;
      }

      loadResourceContent(nextMode);
    });
  });
}

function renderResourceView() {
  const resource = state.resource;
  renderConnection();
  renderAuthPrompt();

  if (!resource) {
    resourcePageSubtitle.textContent = route.resourceId
      ? `资源 ${route.resourceId} 目前不在快照里，可能已经被删除或还未同步。`
      : "当前没有可展示的资源。";
    resourceTitle.textContent = "没有找到这份资源";
    resourceSubtitle.textContent = "请返回 AI 经理，让我重新定位你要查看的资源。";
    resourceStatusBadges.innerHTML = "";
    resourceMetaGrid.innerHTML = "";
    resourcePreview.textContent = "当前没有资源摘要可显示。";
    resourceContentTitle.textContent = "正文摘录";
    resourceContent.textContent = "当前没有可读取的资源内容。";
    renderActions(null);
    return;
  }

  resourcePageSubtitle.textContent = `${resource.primaryAgentName || route.agentName || "未分配员工"} · ${
    route.deviceName || "当前设备"
  }`;
  resourceTitle.textContent = compactResourceName(resource.name || "未命名资源");
  resourceSubtitle.textContent = `${
    resource.primaryAgentName || route.agentName || "数字员工"
  } 上传或引用了这份内容。`;
  resourceStatusBadges.innerHTML = renderStatusBadges(resource);

  const metaItems = [
    ["状态", resource.statusLabel || resource.status || "未知"],
    ["类型", resource.mime || resource.kind || "text/plain"],
    ["大小", formatFileSize(resource.size)],
    ["行数", resource.lineCount ? `${resource.lineCount} 行` : "--"],
    ["工作区", resource.workspaceName || "--"],
    ["关联任务", resource.primaryTaskTitle || "--"],
    ["来源会话", resource.sourceConversationTitle || resource.sourceConversationId || "--"],
    ["更新时间", formatDateTime(resource.updatedAt)],
  ];

  resourceMetaGrid.innerHTML = metaItems
    .map(
      ([label, value]) => `
        <div class="context-item">
          <span class="context-label">${escapeHtml(label)}</span>
          <span class="context-value">${escapeHtml(value || "--")}</span>
        </div>
      `
    )
    .join("");

  resourcePreview.textContent =
    resource.summary ||
    resource.previewText ||
    "这份资源还没有摘要，我现在只保留了正文预览。";
  resourceContentTitle.textContent =
    state.content.mode === "tail" ? "正文尾部摘录" : "正文头部摘录";
  resourceContent.textContent = state.content.loading
    ? "正在读取资源内容..."
    : state.content.error
      ? state.content.error
      : state.content.text || "这份资源当前没有可展示的正文内容。";

  renderActions(resource);
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
    snapshotRecovery.scheduleSnapshotFallback("resource-open");
    renderResourceView();
  });

  socket.addEventListener("close", () => {
    state.connected = false;
    if (state.socket === socket) {
      state.socket = null;
    }
    renderResourceView();
    if (!state.auth.blocked) {
      window.setTimeout(connect, 1500);
      snapshotRecovery.scheduleSnapshotFallback("resource-close");
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
      state.resource =
        (state.snapshot?.resources || []).find((resource) => resource.id === route.resourceId) ||
        null;
      renderResourceView();
    }
  });
}

const snapshotRecovery = installSnapshotRecovery({
  connect,
  refreshSnapshot,
  isAuthBlocked: () => state.auth.blocked,
  hasSnapshot: () => Boolean(state.snapshot?.resources?.length || state.snapshot?.tasks?.length),
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
renderResourceView();
