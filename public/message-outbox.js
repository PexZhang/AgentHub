export const LOCAL_OUTBOX_MAX_MESSAGES = 3;
export const LOCAL_OUTBOX_TTL_MS = 45_000;
export const LOCAL_PENDING_STATUS = "pending_local";
export const LOCAL_SENDING_STATUS = "sending_local";

const ACTIVE_LOCAL_STATUSES = new Set([LOCAL_PENDING_STATUS, LOCAL_SENDING_STATUS]);

function createLocalId() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function createLocalOutboxMessage({
  text,
  conversationId = null,
  agentId = null,
  kind = "direct",
  errorMessage = null,
  status = LOCAL_PENDING_STATUS,
} = {}) {
  const now = new Date();
  const clientMessageId = `client-${createLocalId()}`;
  return {
    id: clientMessageId,
    clientMessageId,
    role: "user",
    text: String(text || "").trim(),
    status,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + LOCAL_OUTBOX_TTL_MS).toISOString(),
    errorMessage: errorMessage || null,
    conversationId,
    agentId,
    kind,
    localOnly: true,
  };
}

export function isLocalOutboxMessageActive(message) {
  return ACTIVE_LOCAL_STATUSES.has(String(message?.status || "").trim());
}

export function countActiveLocalOutboxMessages(messages) {
  return (messages || []).filter((message) => isLocalOutboxMessageActive(message)).length;
}

export function expireLocalOutboxMessages(
  messages,
  {
    now = Date.now(),
    errorMessage = `超过 ${Math.round(LOCAL_OUTBOX_TTL_MS / 1000)} 秒仍未发出，已停止自动补发。`,
  } = {}
) {
  let changed = false;

  const nextMessages = (messages || []).map((message) => {
    if (!isLocalOutboxMessageActive(message)) {
      return message;
    }

    const expiresAt = new Date(message.expiresAt || 0).getTime();
    if (!Number.isFinite(expiresAt) || expiresAt > now) {
      return message;
    }

    changed = true;
    return {
      ...message,
      status: "failed",
      failedAt: new Date(now).toISOString(),
      errorMessage,
    };
  });

  return {
    messages: nextMessages,
    changed,
  };
}

export function mergeServerAndLocalMessages(serverMessages, localMessages) {
  const deliveredIds = new Set(
    (serverMessages || []).map((message) => String(message?.clientMessageId || "").trim()).filter(Boolean)
  );
  let changed = false;

  const nextLocalMessages = (localMessages || []).filter((message) => {
    if (!deliveredIds.has(String(message?.clientMessageId || "").trim())) {
      return true;
    }

    changed = true;
    return false;
  });

  const mergedMessages = [...(serverMessages || []), ...nextLocalMessages].sort((left, right) => {
    const leftTime = new Date(left?.createdAt || 0).getTime();
    const rightTime = new Date(right?.createdAt || 0).getTime();

    if (leftTime !== rightTime) {
      return leftTime - rightTime;
    }

    return String(left?.id || "").localeCompare(String(right?.id || ""));
  });

  return {
    messages: mergedMessages,
    localMessages: nextLocalMessages,
    changed,
  };
}

export function flushLocalOutboxMessages(messages, { send, now = Date.now() } = {}) {
  let changed = false;

  const nextMessages = (messages || []).map((message) => {
    if (!isLocalOutboxMessageActive(message)) {
      return message;
    }

    if (!send?.(message)) {
      return message;
    }

    changed = true;
    return {
      ...message,
      status: LOCAL_SENDING_STATUS,
      lastAttemptAt: new Date(now).toISOString(),
      errorMessage: null,
    };
  });

  return {
    messages: nextMessages,
    changed,
  };
}
