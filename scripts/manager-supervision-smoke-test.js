import { spawn } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import { join } from "path";
import WebSocket from "ws";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomPort() {
  return 4500 + Math.floor(Math.random() * 500);
}

function spawnProcess(command, args, { cwd, env, label }) {
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";

  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });

  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });

  child.label = label;
  child.getOutput = () => ({ stdout, stderr });
  return child;
}

async function waitForHealth(hubOrigin, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${hubOrigin}/api/health`);
      if (response.ok) {
        return response.json();
      }
    } catch {
      // not ready yet
    }
    await sleep(250);
  }

  throw new Error("Manager supervision smoke timed out while waiting for Hub health.");
}

async function fetchState(hubOrigin, appToken) {
  const response = await fetch(`${hubOrigin}/api/state`, {
    headers: {
      "x-agenthub-token": appToken,
    },
  });
  if (!response.ok) {
    throw new Error(`读取状态失败：${response.status}`);
  }
  return response.json();
}

async function waitForOnlineAgent(hubOrigin, appToken, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = await fetchState(hubOrigin, appToken);
    const onlineAgent = (snapshot.agents || []).find((agent) => agent.online);
    if (onlineAgent) {
      return onlineAgent;
    }
    await sleep(250);
  }

  throw new Error("Manager supervision smoke timed out while waiting for an online agent.");
}

async function waitForMatch(hubOrigin, appToken, match, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = await fetchState(hubOrigin, appToken);
    const result = match(snapshot);
    if (result) {
      return result;
    }
    await sleep(250);
  }

  throw new Error("Manager supervision smoke timed out while waiting for expected state.");
}

async function stopProcess(child) {
  if (!child || child.killed) {
    return;
  }

  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    sleep(2000),
  ]);

  if (!child.killed) {
    child.kill("SIGKILL");
  }
}

async function main() {
  const repoRoot = "/Users/zhangpeng/ai-chat-mvp";
  const tempRoot = await fs.mkdtemp(join(os.tmpdir(), "agenthub-manager-supervision-"));
  const dataFile = join(tempRoot, "state.json");
  const hubPort = randomPort();
  const hubOrigin = `http://127.0.0.1:${hubPort}`;
  const appToken = "manager-supervision-app-token";
  const agentToken = "manager-supervision-agent-token";
  const socketUrl = hubOrigin.replace(/^http/u, "ws") + "/ws";

  let hub = null;
  let agent = null;
  let socket = null;

  try {
    hub = spawnProcess(process.execPath, ["server/index.js"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PORT: String(hubPort),
        APP_TOKEN: appToken,
        AGENT_TOKEN: agentToken,
        DATA_FILE: dataFile,
        MANAGER_PROVIDER: "local",
      },
      label: "hub",
    });
    await waitForHealth(hubOrigin);

    agent = spawnProcess(
      process.execPath,
      [
        "agent/index.js",
        "--hub",
        hubOrigin,
        "--agent-token",
        agentToken,
        "--device-name",
        "Supervision Smoke Device",
        "--agent-name",
        "Supervision Smoke Agent",
        "--agent-mode",
        "echo",
        "--root",
        tempRoot,
        "--codex-workdir",
        tempRoot,
      ],
      {
        cwd: repoRoot,
        env: process.env,
        label: "agent",
      }
    );

    const onlineAgent = await waitForOnlineAgent(hubOrigin, appToken);

    socket = new WebSocket(socketUrl);
    await new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    socket.send(JSON.stringify({ type: "hello", role: "app", token: appToken }));
    socket.send(
      JSON.stringify({
        type: "manager_message",
        text: `催一下 ${onlineAgent.name}`,
      })
    );

    await waitForMatch(
      hubOrigin,
      appToken,
      (snapshot) => {
        const managerAssistant = [...(snapshot.manager?.messages || [])]
          .reverse()
          .find(
            (item) =>
              item.role === "assistant" &&
              String(item.text || "").includes("跟进消息发给")
          );
        const directConversation = (snapshot.conversations || []).find(
          (conversation) =>
            conversation.agentId === onlineAgent.id &&
            conversation.messages.some((message) =>
              String(message.text || "").includes("请尽快汇报你当前的进度")
            )
        );
        return managerAssistant && directConversation ? { managerAssistant, directConversation } : null;
      },
      15000
    );

    console.log("Manager supervision smoke test passed.");
  } finally {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.close();
    }
    await stopProcess(agent);
    await stopProcess(hub);
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message || "Manager supervision smoke test failed.");
  process.exit(1);
});
