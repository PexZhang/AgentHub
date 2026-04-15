import WebSocket from "ws";

const HUB_ORIGIN = process.env.HUB_ORIGIN || "http://localhost:3000";
const HUB_WS_URL = HUB_ORIGIN.replace(/^http/, "ws") + "/ws";
const APP_TOKEN = process.env.APP_TOKEN || "";
const TEST_TEXT =
  process.env.TEST_TEXT || `smoke delegation ${Math.random().toString(36).slice(2, 8)}`;
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS || 15000);
const DEBUG = process.env.DEBUG_MANAGER_SMOKE === "1";

function debugLog(...args) {
  if (DEBUG) {
    console.log("[manager-smoke]", ...args);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchState() {
  const response = await fetch(`${HUB_ORIGIN}/api/state`, {
    headers: {
      "x-agenthub-token": APP_TOKEN,
    },
  });

  if (!response.ok) {
    throw new Error(`读取状态失败：${response.status}`);
  }

  return response.json();
}

async function waitForState(match, timeoutMs = TIMEOUT_MS, intervalMs = 300) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = await fetchState();
    const result = match(snapshot);
    if (result) {
      return result;
    }
    await sleep(intervalMs);
  }

  throw new Error("Manager smoke test timed out.");
}

async function main() {
  const socket = new WebSocket(HUB_WS_URL);

  socket.once("open", () => {
    socket.send(JSON.stringify({ type: "hello", role: "app", token: APP_TOKEN }));
  });

  socket.on("message", (raw) => {
    const payload = JSON.parse(String(raw));
    if (payload.type === "auth_required") {
      console.error(payload.message || "Manager smoke auth failed.");
      process.exit(1);
    }
  });

  const onlineAgent = await waitForState((snapshot) =>
    (snapshot.agents || []).find((agent) => agent.online)
  );
  debugLog("online agent", onlineAgent.id, onlineAgent.name);
  const workspace =
    onlineAgent.workspaces?.[0] ||
    ((await fetchState()).workspaces || []).find((item) => item.employeeId === onlineAgent.id) ||
    null;
  debugLog("workspace", workspace?.id || null, workspace?.name || null);

  const workspaceScope = workspace ? `在 ${workspace.name} 仓库` : "";
  const managerText = `让 ${onlineAgent.name} ${workspaceScope} 处理 ${TEST_TEXT}`
    .replace(/\s+/g, " ")
    .trim();

  socket.send(
    JSON.stringify({
      type: "manager_message",
      text: managerText,
    })
  );
  debugLog("sent manager message", managerText);

  await waitForState((snapshot) => {
    const assistantMessage = [...(snapshot.manager?.messages || [])]
      .reverse()
      .find((item) => item.role === "assistant" && String(item.text || "").includes(TEST_TEXT));
    const delegatedTask = (snapshot.tasks || []).find(
      (task) =>
        task.agentId === onlineAgent.id &&
        [task.title, task.lastUserText, task.progressSummary]
          .map((value) => String(value || ""))
          .some((value) => value.includes(TEST_TEXT))
    );
    const delegatedConversation = (snapshot.conversations || []).find(
      (conversation) =>
        conversation.agentId === onlineAgent.id &&
        (!workspace || conversation.workspaceId === workspace.id) &&
        conversation.messages.some(
          (message) => message.role === "user" && String(message.text || "").includes(TEST_TEXT)
        )
    );
    debugLog("poll", {
      managerCount: snapshot.manager?.messages?.length || 0,
      hasAssistant: Boolean(assistantMessage),
      hasTask: Boolean(delegatedTask),
      hasConversation: Boolean(delegatedConversation),
    });

    return assistantMessage && delegatedTask && delegatedConversation
      ? { assistantMessage, delegatedTask, delegatedConversation }
      : null;
  });

  console.log("Manager smoke test passed.");
  socket.close();
}

main().catch((error) => {
  console.error(error.message || "Manager smoke test failed.");
  process.exit(1);
});
