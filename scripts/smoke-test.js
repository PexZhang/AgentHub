import WebSocket from "ws";

const HUB_ORIGIN = process.env.HUB_ORIGIN || "http://localhost:3000";
const HUB_WS_URL = HUB_ORIGIN.replace(/^http/, "ws") + "/ws";
const APP_TOKEN = process.env.APP_TOKEN || "";
const TEST_TEXT =
  process.env.TEST_TEXT || `ping from smoke test ${Math.random().toString(36).slice(2, 8)}`;

let sent = false;

const socket = new WebSocket(HUB_WS_URL);

socket.on("open", () => {
  socket.send(JSON.stringify({ type: "hello", role: "app", token: APP_TOKEN }));
});

socket.on("message", (raw) => {
  const payload = JSON.parse(String(raw));
  if (payload.type === "auth_required") {
    console.error(payload.message || "Smoke test auth failed.");
    process.exit(1);
  }
  if (payload.type !== "snapshot") {
    return;
  }

  const onlineAgent = (payload.data.agents || []).find((agent) => agent.online);
  if (!onlineAgent) {
    console.error("No online agent available for smoke test.");
    process.exit(1);
  }

  const conversations = (payload.data.conversations || []).filter(
    (item) => item.agentId === onlineAgent.id
  );

  if (!sent) {
    sent = true;
    socket.send(
      JSON.stringify({
        type: "user_message",
        agentId: onlineAgent.id,
        text: TEST_TEXT,
      })
    );
    return;
  }

  if (conversations.length === 0) {
    return;
  }

  const replied = conversations.some((conversation) =>
    conversation.messages.some(
      (message) => message.role === "assistant" && message.text.includes(TEST_TEXT)
    )
  );

  if (replied) {
    console.log("Smoke test passed.");
    process.exit(0);
  }
});

setTimeout(() => {
  console.error("Smoke test timed out.");
  process.exit(1);
}, 10000);
