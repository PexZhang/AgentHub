import { promises as fs } from "fs";
import { createHash, randomUUID } from "crypto";
import { dirname, extname, join } from "path";
import {
  buildConversationTitle,
  normalizeDeviceId,
  normalizeDeviceName,
  normalizeText,
} from "../shared/domain-utils.js";
import {
  buildDefaultManagerState,
  buildDefaultStoreState,
  buildPersistedResourceDescriptor,
  buildPersistedTaskDescriptor,
  buildSnapshotMessageWindow,
  buildTaskDescriptor,
  compareByRecency,
  inferAgentModeFromConversations,
  normalizeApprovalRecord,
  normalizeManagerMessage,
  normalizePersistedStoreState,
  normalizeStoredEmployeeRecord,
  normalizeStoredResourceRecord,
  normalizeStoredTaskRecord,
  normalizeTaskResourceLinkRecord,
  normalizeStoredWorkspaceRecord,
} from "./state-model.js";

function countTextLines(text) {
  const normalized = String(text || "");
  if (!normalized) {
    return 0;
  }

  return normalized.split(/\r\n|\r|\n/u).length;
}

function buildPreviewText(text, maxLines = 8, maxCharacters = 420) {
  const normalized = String(text || "").trim();
  if (!normalized) {
    return "";
  }

  const lines = normalized.split(/\r\n|\r|\n/u).slice(0, maxLines);
  const preview = lines.join("\n");
  return preview.length <= maxCharacters ? preview : `${preview.slice(0, maxCharacters)}…`;
}

function toSafeResourceFileName(resourceId, resourceName) {
  const normalizedId = normalizeText(resourceId) || randomUUID();
  const extension = extname(normalizeText(resourceName)).slice(0, 12) || ".txt";
  return `${normalizedId}${extension}`;
}

export class JsonStore {
  constructor(options = {}) {
    this.filePath = options.filePath;
    this.resourceDir = options.resourceDir || join(dirname(options.filePath || "."), "resources");
    this.snapshotConversationMessageLimit = Math.max(
      1,
      Number(options.snapshotConversationMessageLimit || 120)
    );
    this.snapshotManagerMessageLimit = Math.max(
      1,
      Number(options.snapshotManagerMessageLimit || 80)
    );
    this.managerProvider = normalizeText(options.managerProvider) || "local";
    this.managerModel = normalizeText(options.managerModel) || "local-summary";
    this.state = buildDefaultStoreState();
    this.writeQueue = Promise.resolve();
  }

  async init() {
    await fs.mkdir(dirname(this.filePath), { recursive: true });
    await fs.mkdir(this.resourceDir, { recursive: true });

    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const nextState = normalizePersistedStoreState(JSON.parse(raw));
      if (!nextState) {
        await this.persist();
        return;
      }

      this.state = nextState;
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

  async close() {
    await this.writeQueue;
  }

  listConversations() {
    return this.state.conversations;
  }

  listResources() {
    return this.state.resources || [];
  }

  getResource(resourceId) {
    return this.listResources().find((resource) => resource.id === resourceId) || null;
  }

  async createTextResource(resource) {
    const text = String(resource?.text || "");
    const resourceId = normalizeText(resource?.id) || randomUUID();
    const fileName = toSafeResourceFileName(resourceId, resource?.name);
    const storagePath = join(this.resourceDir, fileName);
    const buffer = Buffer.from(text, "utf8");
    await fs.writeFile(storagePath, buffer);

    const nextResource = normalizeStoredResourceRecord({
      id: resourceId,
      name: resource?.name,
      kind: "text",
      mime: normalizeText(resource?.mime) || "text/plain",
      size: buffer.byteLength,
      sha256: createHash("sha256").update(buffer).digest("hex"),
      storagePath,
      encoding: "utf-8",
      lineCount: countTextLines(text),
      summary: normalizeText(resource?.summary) || null,
      previewText: buildPreviewText(text),
      uploadedBy: resource?.uploadedBy,
      sourceConversationId: resource?.sourceConversationId,
      sourceMessageId: resource?.sourceMessageId,
      workspaceId: resource?.workspaceId,
      status: resource?.status || "available",
      tags: Array.isArray(resource?.tags) ? resource.tags : [],
      createdAt: resource?.createdAt,
      updatedAt: resource?.updatedAt,
    });

    this.state.resources.push(nextResource);
    await this.persist();
    return nextResource;
  }

  async updateResource(resourceId, patch) {
    const resource = this.getResource(resourceId);
    if (!resource) {
      return null;
    }

    const nextResource = normalizeStoredResourceRecord({
      ...resource,
      ...patch,
      id: resource.id,
      createdAt: resource.createdAt,
      updatedAt: patch?.updatedAt || new Date().toISOString(),
    });
    Object.assign(resource, nextResource);
    await this.persist();
    return resource;
  }

  async readTextResource(resourceId) {
    const resource = this.getResource(resourceId);
    if (!resource) {
      return null;
    }

    const content = await fs.readFile(resource.storagePath, "utf8");
    return {
      resource,
      content,
    };
  }

  async readTextResourceSlice(resourceId, options = {}) {
    const loaded = await this.readTextResource(resourceId);
    if (!loaded) {
      return null;
    }

    const content = loaded.content;
    const lines = content.split(/\r\n|\r|\n/u);
    const mode = normalizeText(options.mode).toLowerCase() || "full";
    const limitLines = Math.max(1, Number(options.limitLines || 120));
    const startLine = Math.max(1, Number(options.startLine || 1));
    const endLine = Math.max(startLine, Number(options.endLine || startLine + limitLines - 1));
    const query = normalizeText(options.query);

    if (mode === "head") {
      return {
        ...loaded,
        mode,
        startLine: 1,
        endLine: Math.min(lines.length, limitLines),
        totalLineCount: lines.length,
        content: lines.slice(0, limitLines).join("\n"),
      };
    }

    if (mode === "tail") {
      const sliceStart = Math.max(0, lines.length - limitLines);
      return {
        ...loaded,
        mode,
        startLine: sliceStart + 1,
        endLine: lines.length,
        totalLineCount: lines.length,
        content: lines.slice(sliceStart).join("\n"),
      };
    }

    if (mode === "slice") {
      return {
        ...loaded,
        mode,
        startLine,
        endLine: Math.min(lines.length, endLine),
        totalLineCount: lines.length,
        content: lines.slice(startLine - 1, endLine).join("\n"),
      };
    }

    if (mode === "search" && query) {
      const loweredQuery = query.toLowerCase();
      const hits = [];

      for (let index = 0; index < lines.length; index += 1) {
        if (!lines[index].toLowerCase().includes(loweredQuery)) {
          continue;
        }

        const excerptStart = Math.max(0, index - 2);
        const excerptEnd = Math.min(lines.length, index + 3);
        hits.push({
          line: index + 1,
          excerpt: lines.slice(excerptStart, excerptEnd).join("\n"),
        });

        if (hits.length >= Math.max(1, Number(options.maxHits || 8))) {
          break;
        }
      }

      return {
        ...loaded,
        mode,
        query,
        totalLineCount: lines.length,
        hits,
        content: hits
          .map((hit) => `[line ${hit.line}]\n${hit.excerpt}`)
          .join("\n\n"),
      };
    }

    return {
      ...loaded,
      mode: "full",
      startLine: 1,
      endLine: lines.length,
      totalLineCount: lines.length,
      content,
    };
  }

  listTaskResourceLinks() {
    return this.state.taskResourceLinks || [];
  }

  listTaskResourceLinksByTask(taskId) {
    return this.listTaskResourceLinks().filter((link) => link.taskId === taskId);
  }

  listTaskResourceLinksByResource(resourceId) {
    return this.listTaskResourceLinks().filter((link) => link.resourceId === resourceId);
  }

  async createTaskResourceLink(link) {
    const nextLink = normalizeTaskResourceLinkRecord(link, this.state.taskResourceLinks.length);
    this.state.taskResourceLinks.push(nextLink);
    await this.persist();
    return nextLink;
  }

  listWorkspaces() {
    return this.state.workspaces;
  }

  listEmployees() {
    return this.state.employees;
  }

  getEmployee(employeeId) {
    return this.state.employees.find((employee) => employee.id === employeeId) || null;
  }

  async upsertEmployee(employee) {
    const nextEmployee = normalizeStoredEmployeeRecord(employee);
    const index = this.state.employees.findIndex((item) => item.id === nextEmployee.id);
    if (index === -1) {
      this.state.employees.push(nextEmployee);
    } else {
      this.state.employees[index] = {
        ...this.state.employees[index],
        ...nextEmployee,
      };
    }
    await this.persist();
    return nextEmployee;
  }

  async updateEmployee(employeeId, patch) {
    const employee = this.getEmployee(employeeId);
    if (!employee) {
      return null;
    }

    const nextEmployee = normalizeStoredEmployeeRecord({
      ...employee,
      ...patch,
      id: employee.id,
      updatedAt: patch?.updatedAt || new Date().toISOString(),
    });
    Object.assign(employee, nextEmployee);
    await this.persist();
    return employee;
  }

  async markEmployeeOffline(employeeId) {
    const employee = this.getEmployee(employeeId);
    if (!employee) {
      return null;
    }

    employee.online = false;
    employee.status = employee.currentTaskId ? employee.status || "offline" : "offline";
    employee.updatedAt = new Date().toISOString();
    employee.lastSeenAt = employee.updatedAt;
    await this.persist();
    return employee;
  }

  getWorkspace(workspaceId) {
    return this.state.workspaces.find((workspace) => workspace.id === workspaceId);
  }

  listWorkspacesByEmployee(employeeId) {
    return this.state.workspaces.filter((workspace) => workspace.employeeId === employeeId);
  }

  findWorkspaceByEmployeeAndPath(employeeId, pathValue) {
    const normalizedPath = normalizeText(pathValue);
    if (!normalizedPath) {
      return null;
    }

    return (
      this.state.workspaces.find(
        (workspace) =>
          workspace.employeeId === employeeId && normalizeText(workspace.path) === normalizedPath
      ) || null
    );
  }

  async upsertWorkspaces(workspaces) {
    if (!Array.isArray(workspaces) || workspaces.length === 0) {
      return [];
    }

    let changed = false;
    const now = new Date().toISOString();

    for (const [index, workspace] of workspaces.entries()) {
      const nextWorkspace = normalizeStoredWorkspaceRecord(
        {
          ...workspace,
          updatedAt: workspace?.updatedAt || now,
        },
        index
      );
      const existingIndex = this.state.workspaces.findIndex((item) => item.id === nextWorkspace.id);

      if (existingIndex === -1) {
        this.state.workspaces.push(nextWorkspace);
        changed = true;
        continue;
      }

      this.state.workspaces[existingIndex] = {
        ...this.state.workspaces[existingIndex],
        ...nextWorkspace,
      };
      changed = true;
    }

    if (changed) {
      await this.persist();
    }

    return workspaces;
  }

  async markEmployeeWorkspacesOffline(employeeId) {
    if (!employeeId) {
      return;
    }

    let changed = false;
    const updatedAt = new Date().toISOString();

    for (const workspace of this.state.workspaces) {
      if (workspace.employeeId !== employeeId || workspace.online === false) {
        continue;
      }

      workspace.online = false;
      workspace.updatedAt = updatedAt;
      changed = true;
    }

    if (changed) {
      await this.persist();
    }
  }

  listTasks() {
    return this.state.tasks;
  }

  listApprovals() {
    return this.state.approvals;
  }

  listPendingApprovals() {
    return this.state.approvals.filter((approval) => approval.status === "pending");
  }

  getApproval(approvalId) {
    return this.state.approvals.find((approval) => approval.id === approvalId) || null;
  }

  async createApproval(approval) {
    const nextApproval = normalizeApprovalRecord(approval);
    this.state.approvals.push(nextApproval);
    await this.persist();
    return nextApproval;
  }

  async updateApproval(approvalId, patch) {
    const approval = this.getApproval(approvalId);
    if (!approval) {
      return null;
    }

    const nextApproval = normalizeApprovalRecord({
      ...approval,
      ...patch,
      id: approval.id,
      createdAt: approval.createdAt,
      updatedAt: patch?.updatedAt || new Date().toISOString(),
    });
    Object.assign(approval, nextApproval);
    await this.persist();
    return approval;
  }

  getTask(taskId) {
    return this.state.tasks.find((task) => task.id === taskId);
  }

  listTasksByEmployee(employeeId) {
    return this.state.tasks.filter((task) => task.ownerEmployeeId === employeeId);
  }

  listTasksByConversation(conversationId) {
    return this.state.tasks.filter((task) => task.sourceConversationId === conversationId);
  }

  getLatestTaskForConversation(conversationId) {
    return this.listTasksByConversation(conversationId).sort(compareByRecency)[0] || null;
  }

  findTaskBySourceMessageId(messageId) {
    return this.state.tasks.find((task) => task.sourceMessageId === messageId) || null;
  }

  async createTask(task) {
    const nextTask = normalizeStoredTaskRecord(task);
    this.state.tasks.push(nextTask);
    await this.persist();
    return nextTask;
  }

  async updateTask(taskId, patch) {
    const task = this.getTask(taskId);
    if (!task) {
      return null;
    }

    const nextTask = normalizeStoredTaskRecord({
      ...task,
      ...patch,
      id: task.id,
      createdAt: task.createdAt,
      updatedAt: patch?.updatedAt || new Date().toISOString(),
    });
    Object.assign(task, nextTask);
    await this.persist();
    return task;
  }

  async deleteTasksByConversationId(conversationId) {
    const removedTaskIds = this.state.tasks
      .filter((task) => task.sourceConversationId === conversationId)
      .map((task) => task.id);
    const before = this.state.tasks.length;
    this.state.tasks = this.state.tasks.filter((task) => task.sourceConversationId !== conversationId);
    if (removedTaskIds.length > 0) {
      this.state.approvals = this.state.approvals.filter(
        (approval) => !removedTaskIds.includes(approval.taskId)
      );
      this.state.taskResourceLinks = this.state.taskResourceLinks.filter(
        (link) => !removedTaskIds.includes(link.taskId)
      );
    }
    if (this.state.tasks.length !== before || removedTaskIds.length > 0) {
      await this.persist();
    }
  }

  getManagerState() {
    if (!this.state.manager) {
      this.state.manager = buildDefaultManagerState();
    }

    return this.state.manager;
  }

  listManagerMessages() {
    return this.getManagerState().messages;
  }

  listConversationsByAgent(agentId) {
    return this.state.conversations.filter((conversation) => conversation.agentId === agentId);
  }

  getConversation(conversationId) {
    return this.state.conversations.find(
      (conversation) => conversation.id === conversationId
    );
  }

  findConversationByCodexSession(agentId, codexSessionId, codexHome = null) {
    const normalizedCodexHome = normalizeText(codexHome);
    return this.state.conversations.find(
      (conversation) =>
        conversation.agentId === agentId &&
        conversation.codexSessionId === codexSessionId &&
        (!normalizedCodexHome ||
          !conversation.codexHome ||
          conversation.codexHome === normalizedCodexHome)
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
      workspaceId: normalizeText(options.workspaceId) || null,
      codexWorkdir: normalizeText(options.codexWorkdir) || null,
      codexHome: normalizeText(options.codexHome) || null,
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
    await this.deleteTasksByConversationId(conversationId);
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

  async addManagerMessage(message) {
    const nextMessage = normalizeManagerMessage(message);
    this.getManagerState().messages.push(nextMessage);
    await this.persist();
    return nextMessage;
  }

  async updateManagerMessage(messageId, patch) {
    const message = this.getManagerState().messages.find((item) => item.id === messageId);
    if (!message) {
      return null;
    }

    Object.assign(message, patch);
    await this.persist();
    return message;
  }

  findManagerMessageByClientMessageId(clientMessageId) {
    const normalizedClientMessageId = normalizeText(clientMessageId);
    if (!normalizedClientMessageId) {
      return null;
    }

    return (
      this.getManagerState().messages.find(
        (message) => normalizeText(message.clientMessageId) === normalizedClientMessageId
      ) || null
    );
  }

  async setManagerPreviousResponseId(previousResponseId) {
    this.getManagerState().previousResponseId = normalizeText(previousResponseId) || null;
    await this.persist();
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

  findConversationMessageByClientMessageId(clientMessageId) {
    const normalizedClientMessageId = normalizeText(clientMessageId);
    if (!normalizedClientMessageId) {
      return null;
    }

    for (const conversation of this.state.conversations) {
      const message =
        conversation.messages.find(
          (item) => normalizeText(item.clientMessageId) === normalizedClientMessageId
        ) || null;
      if (message) {
        return {
          conversation,
          message,
        };
      }
    }

    return null;
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
      .map((conversation) => {
        const messageWindow = buildSnapshotMessageWindow(
          conversation.messages,
          this.snapshotConversationMessageLimit
        );

        return {
          ...conversation,
          messages: messageWindow.messages,
          totalMessageCount: messageWindow.totalMessageCount,
          hiddenMessageCount: messageWindow.hiddenMessageCount,
        };
      })
      .sort(
        (left, right) =>
          new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
      );

    const workspaceMap = new Map(
      structuredClone(this.state.workspaces || [])
        .map((workspace, index) => normalizeStoredWorkspaceRecord(workspace, index))
        .filter(Boolean)
        .map((workspace) => [workspace.id, workspace])
    );

    for (const connection of connectedAgents.values()) {
      for (const workspace of connection.workspaces || []) {
        workspaceMap.set(workspace.id, {
          ...workspaceMap.get(workspace.id),
          ...normalizeStoredWorkspaceRecord(workspace),
          employeeId: normalizeText(workspace.employeeId || connection.agentId) || null,
          employeeName: normalizeText(workspace.employeeName || connection.name) || null,
          deviceId: normalizeDeviceId(workspace.deviceId || connection.deviceId),
          deviceName: normalizeDeviceName(workspace.deviceName || connection.deviceName),
          online: true,
          updatedAt:
            normalizeText(workspace.updatedAt) ||
            connection.lastSeenAt ||
            new Date().toISOString(),
        });
      }
    }

    const persistedEmployees = structuredClone(this.state.employees || [])
      .map((employee) => normalizeStoredEmployeeRecord(employee))
      .filter(Boolean);

    const knownAgentIds = new Set([
      ...persistedEmployees.map((employee) => employee.id),
      ...clonedConversations.map((conversation) => conversation.agentId),
      ...connectedAgents.keys(),
      ...[...workspaceMap.values()].map((workspace) => workspace.employeeId).filter(Boolean),
      ...this.state.tasks.map((task) => task.ownerEmployeeId).filter(Boolean),
    ]);

    const agents = [...knownAgentIds]
      .map((agentId) => {
        const connection = connectedAgents.get(agentId);
        const persistedEmployee =
          persistedEmployees.find((employee) => employee.id === agentId) || null;
        const agentConversations = clonedConversations.filter(
          (conversation) => conversation.agentId === agentId
        );
        const recentConversation = agentConversations[0] || null;
        const persistedWorkspaces = [...workspaceMap.values()]
          .filter((workspace) => workspace.employeeId === agentId)
          .sort(compareByRecency);
        const referenceWorkspace = persistedWorkspaces[0] || null;
        const deviceId = normalizeDeviceId(
          connection?.deviceId || recentConversation?.deviceId || referenceWorkspace?.deviceId,
          "default-device"
        );
        const deviceName = normalizeDeviceName(
          connection?.deviceName ||
            recentConversation?.deviceName ||
            referenceWorkspace?.deviceName,
          "当前设备"
        );
        return {
          id: agentId,
          name:
            connection?.name ||
            persistedEmployee?.name ||
            referenceWorkspace?.employeeName ||
            agentId,
          deviceId,
          deviceName,
          mode:
            connection?.mode ||
            persistedEmployee?.runtime ||
            referenceWorkspace?.runtimeHints?.[0] ||
            inferAgentModeFromConversations(agentConversations),
          runtime:
            connection?.mode ||
            persistedEmployee?.runtime ||
            referenceWorkspace?.runtimeHints?.[0] ||
            inferAgentModeFromConversations(agentConversations),
          version: persistedEmployee?.version || null,
          capabilities: persistedEmployee?.capabilities || [],
          recentCodexSessions: connection?.recentCodexSessions || [],
          defaultCodexWorkdir: connection?.defaultCodexWorkdir || null,
          workdirRoots: connection?.workdirRoots || [],
          workspaces: persistedWorkspaces,
          online: Boolean(connection) || persistedWorkspaces.some((workspace) => workspace.online),
          status:
            persistedEmployee?.status ||
            (Boolean(connection)
              ? "online"
              : persistedWorkspaces.some((workspace) => workspace.online)
                ? "online"
                : "offline"),
          currentTaskId: persistedEmployee?.currentTaskId || null,
          currentRunId: persistedEmployee?.currentRunId || null,
          lastSummary: persistedEmployee?.lastSummary || null,
          lastSeenAt:
            connection?.lastSeenAt ||
            persistedEmployee?.lastSeenAt ||
            persistedWorkspaces[0]?.updatedAt ||
            recentConversation?.updatedAt ||
            null,
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

    const workspaces = [...workspaceMap.values()].sort((left, right) => {
      if (left.online !== right.online) {
        return left.online ? -1 : 1;
      }
      return left.name.localeCompare(right.name);
    });

    const agentMap = new Map(agents.map((agent) => [agent.id, agent]));
    const workspaceLookup = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
    const conversationMap = new Map(clonedConversations.map((conversation) => [conversation.id, conversation]));
    const storedTasks = structuredClone(this.state.tasks || [])
      .map((task) => normalizeStoredTaskRecord(task))
      .sort(compareByRecency);
    const tasks = storedTasks
      .map((task) => buildPersistedTaskDescriptor(task, agentMap, workspaceLookup, conversationMap))
      .filter(Boolean);
    const fallbackConversationTasks = clonedConversations
      .filter(
        (conversation) =>
          !storedTasks.some((task) => task.sourceConversationId === conversation.id)
      )
      .map((conversation) => buildTaskDescriptor(conversation, agentMap.get(conversation.agentId)))
      .filter(Boolean)
      .sort(compareByRecency);
    tasks.push(...fallbackConversationTasks);
    tasks.sort(compareByRecency);
    const taskMap = new Map(tasks.map((task) => [task.id, task]));
    const taskResourceLinks = structuredClone(this.state.taskResourceLinks || [])
      .map((link, index) => normalizeTaskResourceLinkRecord(link, index))
      .filter((link) => link?.taskId && link?.resourceId);
    const taskResourceLinksByResourceId = new Map();
    for (const link of taskResourceLinks) {
      const current = taskResourceLinksByResourceId.get(link.resourceId) || [];
      current.push(link);
      taskResourceLinksByResourceId.set(link.resourceId, current);
    }
    const conversationRefsByResourceId = new Map();
    for (const conversation of clonedConversations) {
      for (const message of conversation.messages || []) {
        for (const attachment of message.attachments || []) {
          const resourceId = normalizeText(attachment?.resourceId);
          if (!resourceId) {
            continue;
          }

          const current = conversationRefsByResourceId.get(resourceId) || [];
          current.push(conversation.id);
          conversationRefsByResourceId.set(resourceId, current);
        }
      }
    }
    const resources = structuredClone(this.state.resources || [])
      .map((resource, index) => normalizeStoredResourceRecord(resource, index))
      .map((resource) =>
        buildPersistedResourceDescriptor(resource, {
          taskLinks: taskResourceLinksByResourceId.get(resource.id) || [],
          taskMap,
          workspaceMap: workspaceLookup,
          conversationMap,
          conversationRefs: conversationRefsByResourceId.get(resource.id) || [],
        })
      )
      .filter(Boolean)
      .sort(compareByRecency);
    const approvals = structuredClone(this.state.approvals || [])
      .map((approval) => normalizeApprovalRecord(approval))
      .sort(compareByRecency);

    const managerSummary = {
      onlineAgentCount: agents.filter((agent) => agent.online).length,
      totalAgentCount: agents.length,
      activeTaskCount: tasks.filter((task) => task.active).length,
      blockedTaskCount: tasks.filter((task) => task.blocked).length,
      recentTaskCount: tasks.length,
      workspaceCount: workspaces.length,
      resourceCount: resources.length,
      activeResourceCount: resources.filter((resource) => resource.active).length,
      orphanedResourceCount: resources.filter((resource) => resource.orphaned).length,
      pendingApprovalCount: approvals.filter((approval) => approval.status === "pending").length,
    };

    const managerMessageWindow = buildSnapshotMessageWindow(
      this.getManagerState().messages,
      this.snapshotManagerMessageLimit
    );

    return {
      generatedAt: new Date().toISOString(),
      conversations: clonedConversations,
      agents,
      devices,
      workspaces,
      tasks,
      resources,
      approvals,
      manager: {
        messages: structuredClone(managerMessageWindow.messages),
        totalMessageCount: managerMessageWindow.totalMessageCount,
        hiddenMessageCount: managerMessageWindow.hiddenMessageCount,
        provider: this.managerProvider,
        model: this.managerProvider === "local" ? "local-summary" : this.managerModel,
        previousResponseId: this.getManagerState().previousResponseId,
        summary: managerSummary,
      },
    };
  }
}
