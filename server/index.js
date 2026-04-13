import "dotenv/config";
import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { promises as fs } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const DATA_FILE =
  normalizeText(process.env.DATA_FILE) || join(__dirname, "..", "data", "state.json");
const MAX_RECENT_CODEX_SESSIONS = 12;
const APP_TOKEN = normalizeText(process.env.APP_TOKEN);
const AGENT_TOKEN = normalizeText(process.env.AGENT_TOKEN);

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeDeviceId(value, fallback = "default-device") {
  return normalizeText(value) || fallback;
}

function normalizeDeviceName(value, fallback = "当前设备") {
  return normalizeText(value) || fallback;
}

function isExpectedToken(expectedToken, actualToken) {
  if (!expectedToken) {
    return true;
  }

  return normalizeText(actualToken) === expectedToken;
}

function readBearerToken(request) {
  const authHeader = normalizeText(request.headers.authorization);
  if (authHeader.startsWith("Bearer ")) {
    return authHeader.slice("Bearer ".length).trim();
  }

  return normalizeText(request.headers["x-agenthub-token"]);
}

function buildConversationTitle(text, fallback = "New chat") {
  const normalized = normalizeText(text).replace(/\s+/g, " ");
  if (!normalized) {
    return fallback;
  }

  if (normalized.length <= 24) {
    return normalized;
  }

  return `${normalized.slice(0, 24)}…`;
}

function normalizeCodexSessions(input) {
  if (!Array.isArray(input)) {
    return [];
  }

  const seen = new Set();
  const sessions = [];

  for (const item of input) {
    const id = normalizeText(item?.id);
    if (!id || seen.has(id)) {
      continue;
    }

    seen.add(id);
    sessions.push({
      id,
      threadName:
        normalizeText(item?.threadName || item?.thread_name || item?.title) ||
        "未命名 Session",
      updatedAt:
        normalizeText(item?.updatedAt || item?.updated_at || item?.lastSeenAt) ||
        null,
    });

    if (sessions.length >= MAX_RECENT_CODEX_SESSIONS) {
      break;
    }
  }

  return sessions;
}

function inferAgentModeFromConversations(conversations) {
  if (!Array.isArray(conversations) || conversations.length === 0) {
    return "offline";
  }

  const hasCodexContext = conversations.some(
    (conversation) => conversation.codexSessionId || conversation.codexWorkdir
  );

  return hasCodexContext ? "codex" : "offline";
}

class JsonStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = { conversations: [] };
    this.writeQueue = Promise.resolve();
  }

  async init() {
    await fs.mkdir(dirname(this.filePath), { recursive: true });

    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.conversations)) {
        this.state = parsed;
      } else {
        await this.persist();
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
      await this.persist();
    }
  }

  async persist() {
    const content = JSON.stringify(this.state, null, 2);
    this.writeQueue = this.writeQueue.then(() =>
      fs.writeFile(this.filePath, content, "utf8")
    );
    return this.writeQueue;
  }

  listConversations() {
    return this.state.conversations;
  }

  listConversationsByAgent(agentId) {
    return this.state.conversations.filter((conversation) => conversation.agentId === agentId);
  }

  getConversation(conversationId) {
    return this.state.conversations.find(
      (conversation) => conversation.id === conversationId
    );
  }

  findConversationByCodexSession(agentId, codexSessionId) {
    return this.state.conversations.find(
      (conversation) =>
        conversation.agentId === agentId &&
        conversation.codexSessionId === codexSessionId
    );
  }

  async createConversation(agentId, options = {}) {
    const now = new Date().toISOString();
    const title =
      normalizeText(options.title) ||
      buildConversationTitle(options.codexThreadName, "New chat");

    const conversation = {
      id: randomUUID(),
      agentId,
      title,
      createdAt: now,
      updatedAt: now,
      deviceId: normalizeText(options.deviceId) || null,
      deviceName: normalizeText(options.deviceName) || null,
      codexWorkdir: normalizeText(options.codexWorkdir) || null,
      codexSessionId: normalizeText(options.codexSessionId) || null,
      codexThreadName: normalizeText(options.codexThreadName) || null,
      codexSessionUpdatedAt: normalizeText(options.codexSessionUpdatedAt) || null,
      messages: [],
    };

    this.state.conversations.push(conversation);
    await this.persist();
    return conversation;
  }

  async updateConversation(conversationId, patch) {
    const conversation = this.getConversation(conversationId);
    if (!conversation) {
      return null;
    }

    Object.assign(conversation, patch);
    conversation.updatedAt = new Date().toISOString();
    await this.persist();
    return conversation;
  }

  async deleteConversation(conversationId) {
    const index = this.state.conversations.findIndex(
      (conversation) => conversation.id === conversationId
    );
    if (index === -1) {
      return null;
    }

    const [conversation] = this.state.conversations.splice(index, 1);
    await this.persist();
    return conversation;
  }

  async addMessage(conversationId, message) {
    const conversation = this.getConversation(conversationId);
    if (!conversation) {
      throw new Error(`会话不存在: ${conversationId}`);
    }

    conversation.messages.push(message);
    conversation.updatedAt = message.createdAt;
    await this.persist();
    return message;
  }

  async updateMessage(conversationId, messageId, patch) {
    const conversation = this.getConversation(conversationId);
    if (!conversation) {
      return null;
    }

    const message = conversation.messages.find((item) => item.id === messageId);
    if (!message) {
      return null;
    }

    Object.assign(message, patch);
    conversation.updatedAt = new Date().toISOString();
    await this.persist();
    return message;
  }

  listQueuedMessages(agentId) {
    const queued = [];

    for (const conversation of this.state.conversations) {
      if (conversation.agentId !== agentId) {
        continue;
      }

      for (const message of conversation.messages) {
        if (message.role === "user" && message.status === "queued") {
          queued.push({
            conversationId: conversation.id,
            message,
            conversation,
          });
        }
      }
    }

    return queued.sort(
      (left, right) =>
        new Date(left.message.createdAt).getTime() -
        new Date(right.message.createdAt).getTime()
    );
  }

  buildSnapshot(connectedAgents) {
    const clonedConversations = structuredClone(this.state.conversations)
      .map((conversation) => ({
        ...conversation,
        messages: [...conversation.messages].sort(
          (left, right) =>
            new Date(left.createdAt).getTime() -
            new Date(right.createdAt).getTime()
        ),
      }))
      .sort(
        (left, right) =>
          new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
      );

    const knownAgentIds = new Set([
      ...clonedConversations.map((conversation) => conversation.agentId),
      ...connectedAgents.keys(),
    ]);

    const agents = [...knownAgentIds]
      .map((agentId) => {
        const connection = connectedAgents.get(agentId);
        const agentConversations = clonedConversations.filter(
          (conversation) => conversation.agentId === agentId
        );
        const recentConversation = agentConversations[0] || null;
        const deviceId = normalizeDeviceId(
          connection?.deviceId || recentConversation?.deviceId,
          "default-device"
        );
        const deviceName = normalizeDeviceName(
          connection?.deviceName || recentConversation?.deviceName,
          "当前设备"
        );
        return {
          id: agentId,
          name: connection?.name || agentId,
          deviceId,
          deviceName,
          mode: connection?.mode || inferAgentModeFromConversations(agentConversations),
          recentCodexSessions: connection?.recentCodexSessions || [],
          defaultCodexWorkdir: connection?.defaultCodexWorkdir || null,
          workdirRoots: connection?.workdirRoots || [],
          online: Boolean(connection),
          lastSeenAt: connection?.lastSeenAt || null,
        };
      })
      .sort((left, right) => {
        if (left.online !== right.online) {
          return left.online ? -1 : 1;
        }
        return left.name.localeCompare(right.name);
      });

    const deviceMap = new Map();
    for (const agent of agents) {
      const current = deviceMap.get(agent.deviceId) || {
        id: agent.deviceId,
        name: agent.deviceName,
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

      deviceMap.set(agent.deviceId, current);
    }

    const devices = [...deviceMap.values()].sort((left, right) => {
      if (left.online !== right.online) {
        return left.online ? -1 : 1;
      }
      return left.name.localeCompare(right.name);
    });

    return {
      generatedAt: new Date().toISOString(),
      conversations: clonedConversations,
      agents,
      devices,
    };
  }
}

const store = new JsonStore(DATA_FILE);
await store.init();

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

const appClients = new Set();
const agentClients = new Map();

function sendJson(socket, payload) {
  if (socket.readyState !== 1) {
    return;
  }
  socket.send(JSON.stringify(payload));
}

function buildSnapshot() {
  return store.buildSnapshot(agentClients);
}

function findAppClient(clientId) {
  for (const client of appClients) {
    if (client.clientId === clientId) {
      return client;
    }
  }

  return null;
}

function broadcastSnapshot() {
  const payload = { type: "snapshot", data: buildSnapshot() };
  for (const client of appClients) {
    sendJson(client, payload);
  }
}

async function deliverMessageToAgent(agentId, conversationId, message) {
  const agentConnection = agentClients.get(agentId);
  if (!agentConnection) {
    return false;
  }

  await store.updateMessage(conversationId, message.id, {
    status: "sent",
    deliveredAt: new Date().toISOString(),
  });

  const conversation = store.getConversation(conversationId);
  sendJson(agentConnection.socket, {
    type: "deliver_user_message",
    agentId,
    conversationId,
    message,
    conversation,
  });

  return true;
}

function updateAgentConnection(agentId, patch) {
  const current = agentClients.get(agentId);
  if (!current) {
    return null;
  }

  const next = {
    ...current,
    ...patch,
    lastSeenAt: new Date().toISOString(),
  };

  agentClients.set(agentId, next);
  return next;
}

async function flushQueuedMessages(agentId) {
  const queued = store.listQueuedMessages(agentId);
  for (const item of queued) {
    await deliverMessageToAgent(agentId, item.conversationId, item.message);
  }
  broadcastSnapshot();
}

app.use(express.json());
app.use(express.static(join(__dirname, "..", "public")));

app.get("/api/health", (_request, response) => {
  response.json({
    ok: true,
    port: PORT,
    onlineAgents: [...agentClients.keys()],
    conversationCount: store.listConversations().length,
  });
});

app.get("/api/state", (request, response) => {
  if (!isExpectedToken(APP_TOKEN, readBearerToken(request))) {
    response.status(401).json({
      ok: false,
      error: "UNAUTHORIZED",
      message: "读取状态需要有效的 APP_TOKEN",
    });
    return;
  }

  response.json(buildSnapshot());
});

wss.on("connection", (socket) => {
  socket.on("message", async (raw) => {
    try {
      const payload = JSON.parse(String(raw));

      if (payload.type === "hello" && payload.role === "app") {
        if (!isExpectedToken(APP_TOKEN, payload.token)) {
          sendJson(socket, {
            type: "auth_required",
            message: "这个 AgentHub 需要有效的 APP_TOKEN。",
          });
          socket.close();
          return;
        }

        socket.clientRole = "app";
        socket.authenticated = true;
        socket.clientId = socket.clientId || randomUUID();
        appClients.add(socket);
        sendJson(socket, {
          type: "snapshot",
          data: buildSnapshot(),
          clientId: socket.clientId,
        });
        return;
      }

      if (payload.type === "hello" && payload.role === "agent") {
        if (!isExpectedToken(AGENT_TOKEN, payload.token)) {
          sendJson(socket, {
            type: "error",
            message: "Agent 鉴权失败，请检查 AGENT_TOKEN。",
          });
          socket.close();
          return;
        }

        const agentId = payload.agentId || "local-ai";
        socket.clientRole = "agent";
        socket.authenticated = true;
        socket.agentId = agentId;

        agentClients.set(agentId, {
          socket,
          name: payload.name || agentId,
          deviceId: normalizeDeviceId(payload.deviceId),
          deviceName: normalizeDeviceName(payload.deviceName),
          mode: payload.mode || "echo",
          recentCodexSessions: normalizeCodexSessions(payload.recentCodexSessions),
          defaultCodexWorkdir: normalizeText(payload.defaultCodexWorkdir) || null,
          workdirRoots: Array.isArray(payload.workdirRoots)
            ? payload.workdirRoots.map((value) => normalizeText(value)).filter(Boolean)
            : [],
          lastSeenAt: new Date().toISOString(),
        });

        sendJson(socket, {
          type: "hello_ack",
          agentId,
          serverTime: new Date().toISOString(),
        });

        broadcastSnapshot();
        await flushQueuedMessages(agentId);
        return;
      }

      if (!socket.authenticated) {
        sendJson(socket, {
          type: "auth_required",
          message: "请先完成鉴权。",
        });
        socket.close();
        return;
      }

      if (payload.type === "create_conversation" && socket.clientRole === "app") {
        const agentId = normalizeText(payload.agentId);
        const agentConnection = agentClients.get(agentId);
        if (!agentId) {
          sendJson(socket, { type: "error", message: "创建会话需要 agentId" });
          return;
        }

        const codexSessionId = normalizeText(payload.codexSessionId);
        let conversation =
          codexSessionId &&
          store.findConversationByCodexSession(agentId, codexSessionId);

        if (!conversation) {
          conversation = await store.createConversation(agentId, {
            title: normalizeText(payload.title),
            deviceId: agentConnection?.deviceId || null,
            deviceName: agentConnection?.deviceName || null,
            codexWorkdir: normalizeText(payload.codexWorkdir),
            codexSessionId,
            codexThreadName: normalizeText(payload.codexThreadName),
            codexSessionUpdatedAt: normalizeText(payload.codexSessionUpdatedAt),
          });
          broadcastSnapshot();
        }

        sendJson(socket, {
          type: "conversation_opened",
          conversationId: conversation.id,
        });
        return;
      }

      if (payload.type === "open_codex_session" && socket.clientRole === "app") {
        const agentId = normalizeText(payload.agentId);
        const codexSessionId = normalizeText(payload.codexSessionId);
        const agentConnection = agentClients.get(agentId);

        if (!agentId || !codexSessionId) {
          sendJson(socket, {
            type: "error",
            message: "打开 Codex session 需要 agentId 和 codexSessionId",
          });
          return;
        }

        let conversation = store.findConversationByCodexSession(agentId, codexSessionId);

        if (!conversation) {
          conversation = await store.createConversation(agentId, {
            deviceId: agentConnection?.deviceId || null,
            deviceName: agentConnection?.deviceName || null,
            codexWorkdir: normalizeText(payload.codexWorkdir),
            codexSessionId,
            codexThreadName: normalizeText(payload.codexThreadName),
            codexSessionUpdatedAt: normalizeText(payload.codexSessionUpdatedAt),
          });
          broadcastSnapshot();
        } else if (
          (!conversation.codexThreadName && normalizeText(payload.codexThreadName)) ||
          (!conversation.codexWorkdir && normalizeText(payload.codexWorkdir))
        ) {
          conversation = await store.updateConversation(conversation.id, {
            codexThreadName: normalizeText(payload.codexThreadName),
            codexWorkdir:
              normalizeText(payload.codexWorkdir) || conversation.codexWorkdir || null,
            title:
              conversation.title && conversation.title !== "New chat"
                ? conversation.title
                : buildConversationTitle(payload.codexThreadName, "Codex Session"),
          });
          broadcastSnapshot();
        }

        sendJson(socket, {
          type: "conversation_opened",
          conversationId: conversation.id,
        });
        return;
      }

      if (payload.type === "list_agent_directories" && socket.clientRole === "app") {
        const agentId = normalizeText(payload.agentId);
        const agentConnection = agentClients.get(agentId);

        if (!agentConnection) {
          sendJson(socket, {
            type: "error",
            message: "目标数字员工当前不在线，无法读取目录",
          });
          return;
        }

        sendJson(agentConnection.socket, {
          type: "list_agent_directories",
          appClientId: socket.clientId || null,
          requestId: normalizeText(payload.requestId),
          path: normalizeText(payload.path),
        });
        return;
      }

      if (payload.type === "user_message" && socket.clientRole === "app") {
        const text = normalizeText(payload.text);
        const requestedAgentId = normalizeText(payload.agentId);
        const requestedConversationId = normalizeText(payload.conversationId);

        let conversation = requestedConversationId
          ? store.getConversation(requestedConversationId)
          : null;
        let agentId = requestedAgentId;

        if (requestedConversationId && !conversation) {
          sendJson(socket, {
            type: "error",
            message: "要发送消息的会话不存在",
          });
          return;
        }

        if (conversation) {
          agentId = conversation.agentId;
        }

        const agentConnection = agentId ? agentClients.get(agentId) : null;

        if (!text || !agentId) {
          sendJson(socket, {
            type: "error",
            message: "发送消息需要 text，以及 agentId 或 conversationId",
          });
          return;
        }

        if (!conversation) {
          conversation = await store.createConversation(agentId, {
            title: buildConversationTitle(text, "New chat"),
            deviceId: agentConnection?.deviceId || null,
            deviceName: agentConnection?.deviceName || null,
          });
        } else if (
          conversation.messages.length === 0 &&
          !conversation.codexSessionId &&
          (!conversation.title || conversation.title === "New chat")
        ) {
          conversation = await store.updateConversation(conversation.id, {
            title: buildConversationTitle(text, "New chat"),
          });
        } else if (
          agentConnection &&
          (!conversation.deviceId || !conversation.deviceName)
        ) {
          conversation = await store.updateConversation(conversation.id, {
            deviceId: agentConnection.deviceId,
            deviceName: agentConnection.deviceName,
          });
        }

        const message = {
          id: randomUUID(),
          role: "user",
          text,
          agentId,
          status: agentClients.has(agentId) ? "sent" : "queued",
          createdAt: new Date().toISOString(),
        };

        await store.addMessage(conversation.id, message);

        if (agentClients.has(agentId)) {
          await deliverMessageToAgent(agentId, conversation.id, message);
        }

        broadcastSnapshot();
        return;
      }

      if (payload.type === "delete_conversation" && socket.clientRole === "app") {
        const conversationId = normalizeText(payload.conversationId);
        if (!conversationId) {
          sendJson(socket, {
            type: "error",
            message: "删除会话需要 conversationId",
          });
          return;
        }

        const deletedConversation = await store.deleteConversation(conversationId);
        if (!deletedConversation) {
          sendJson(socket, {
            type: "error",
            message: "要删除的会话不存在",
          });
          return;
        }

        broadcastSnapshot();
        return;
      }

      if (payload.type === "agent_codex_sessions" && socket.clientRole === "agent") {
        const agentId = socket.agentId;
        if (!agentId) {
          return;
        }

        updateAgentConnection(agentId, {
          recentCodexSessions: normalizeCodexSessions(payload.sessions),
        });
        broadcastSnapshot();
        return;
      }

      if (payload.type === "agent_directory_list" && socket.clientRole === "agent") {
        const targetClient = findAppClient(normalizeText(payload.appClientId));
        if (!targetClient) {
          return;
        }

        sendJson(targetClient, {
          type: "agent_directory_list",
          agentId: socket.agentId,
          requestId: normalizeText(payload.requestId),
          path: normalizeText(payload.path),
          parentPath: normalizeText(payload.parentPath) || null,
          roots: Array.isArray(payload.roots) ? payload.roots : [],
          entries: Array.isArray(payload.entries) ? payload.entries : [],
          error: normalizeText(payload.error) || null,
        });
        return;
      }

      if (payload.type === "agent_status" && socket.clientRole === "agent") {
        const conversationId = normalizeText(payload.conversationId);
        const replyTo = normalizeText(payload.replyTo);
        const status = normalizeText(payload.status);

        if (!conversationId || !replyTo || !status) {
          return;
        }

        const patch = { status };

        if (status === "processing") {
          patch.processingAt = new Date().toISOString();
          patch.errorMessage = null;
        }

        if (status === "failed") {
          patch.failedAt = new Date().toISOString();
          patch.errorMessage = payload.error || "处理失败";
        }

        await store.updateMessage(conversationId, replyTo, patch);
        broadcastSnapshot();
        return;
      }

      if (payload.type === "agent_message" && socket.clientRole === "agent") {
        const text = normalizeText(payload.text);
        const conversationId = normalizeText(payload.conversationId);
        const agentId = socket.agentId;

        if (!text || !conversationId || !agentId) {
          return;
        }

        const conversation = store.getConversation(conversationId);
        if (!conversation) {
          return;
        }

        const codexSessionId = normalizeText(payload.codexSessionId);
        const codexThreadName = normalizeText(payload.codexThreadName);
        const codexSessionUpdatedAt = normalizeText(payload.codexSessionUpdatedAt);
        const codexWorkdir = normalizeText(payload.codexWorkdir);

        if (codexSessionId || codexThreadName || codexSessionUpdatedAt || codexWorkdir) {
          await store.updateConversation(conversationId, {
            codexWorkdir: codexWorkdir || conversation.codexWorkdir || null,
            codexSessionId: codexSessionId || conversation.codexSessionId || null,
            codexThreadName: codexThreadName || conversation.codexThreadName || null,
            codexSessionUpdatedAt:
              codexSessionUpdatedAt || conversation.codexSessionUpdatedAt || null,
            title:
              conversation.title && conversation.title !== "New chat"
                ? conversation.title
                : buildConversationTitle(
                    codexThreadName || conversation.codexThreadName,
                    conversation.title || "Codex Session"
                  ),
          });
        }

        const message = {
          id: randomUUID(),
          role: "assistant",
          text,
          agentId,
          replyTo: payload.replyTo || null,
          createdAt: new Date().toISOString(),
        };

        await store.addMessage(conversationId, message);

        if (payload.replyTo) {
          await store.updateMessage(conversationId, payload.replyTo, {
            status: "answered",
            answeredAt: new Date().toISOString(),
          });
        }

        broadcastSnapshot();
      }
    } catch (error) {
      sendJson(socket, {
        type: "error",
        message: error.message || "未知错误",
      });
    }
  });

  socket.on("close", () => {
    if (socket.clientRole === "app") {
      appClients.delete(socket);
      return;
    }

    if (socket.clientRole === "agent" && socket.agentId) {
      agentClients.delete(socket.agentId);
      broadcastSnapshot();
    }
  });
});

server.listen(PORT, () => {
  console.log(`AgentHub is listening on http://localhost:${PORT}`);
});
