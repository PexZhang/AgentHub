import { spawn } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import { join } from "path";
import WebSocket from "ws";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomPort() {
  return 4700 + Math.floor(Math.random() * 500);
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

  throw new Error("Manager direct-chat clarification smoke timed out while waiting for Hub health.");
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

  throw new Error("Timed out while waiting for an online agent.");
}

async function waitForManagerAssistantMessage(hubOrigin, appToken, match, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const snapshot = await fetchState(hubOrigin, appToken);
    const managerMessage = [...(snapshot.manager?.messages || [])]
      .reverse()
      .find((item) => item.role === "assistant" && match(String(item.text || "")));
    if (managerMessage) {
      return managerMessage;
    }
    await sleep(250);
  }

  throw new Error("Timed out while waiting for expected manager reply.");
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
  const tempRoot = await fs.mkdtemp(join(os.tmpdir(), "agenthub-manager-direct-"));
  const dataFile = join(tempRoot, "state.json");
  const hubPort = randomPort();
  const hubOrigin = `http://127.0.0.1:${hubPort}`;
  const appToken = "manager-direct-app-token";
  const agentToken = "manager-direct-agent-token";
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
        "Direct Chat Smoke Device",
        "--agent-name",
        "Codex Main",
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
        text: "连接员工",
      })
    );

    await waitForManagerAssistantMessage(
      hubOrigin,
      appToken,
      (text) => text.includes("你还没说是哪位") && text.includes(onlineAgent.name)
    );

    socket.send(
      JSON.stringify({
        type: "manager_message",
        text: "谁在线",
      })
    );

    const rosterReply = await waitForManagerAssistantMessage(
      hubOrigin,
      appToken,
      (text) =>
        text.includes(onlineAgent.name) &&
        text.includes("在线") &&
        !text.includes("我还没找到") &&
        !text.includes("对应的员工")
    );

    if (/我还没找到|对应的员工/.test(String(rosterReply.text || ""))) {
      throw new Error(`经理错误地把“谁在线”识别成了员工名补充：${rosterReply.text}`);
    }

    socket.send(
      JSON.stringify({
        type: "manager_message",
        text: "当前有哪些员工",
      })
    );

    const employeeReply = await waitForManagerAssistantMessage(
      hubOrigin,
      appToken,
      (text) =>
        text.includes(onlineAgent.name) &&
        !text.includes("我还没找到") &&
        !text.includes("对应的员工")
    );

    if (/我还没找到|对应的员工/.test(String(employeeReply.text || ""))) {
      throw new Error(`经理错误地把“当前有哪些员工”识别成了员工名补充：${employeeReply.text}`);
    }

    console.log("Manager direct-chat clarification smoke test passed.");
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
  console.error(error.message || "Manager direct-chat clarification smoke test failed.");
  process.exit(1);
});
