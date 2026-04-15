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
      // hub not ready yet
    }

    await sleep(250);
  }

  throw new Error("Manager onboarding smoke timed out while waiting for Hub health.");
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

async function waitForAssistantMessage(hubOrigin, appToken, match, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const snapshot = await fetchState(hubOrigin, appToken);
    const message = [...(snapshot.manager?.messages || [])]
      .reverse()
      .find((item) => item.role === "assistant" && match(String(item.text || "")));
    if (message) {
      return message;
    }

    await sleep(250);
  }

  throw new Error("Manager onboarding smoke timed out while waiting for assistant reply.");
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
  const tempRoot = await fs.mkdtemp(join(os.tmpdir(), "agenthub-manager-onboarding-"));
  const dataFile = join(tempRoot, "state.json");
  const hubPort = randomPort();
  const hubOrigin = `http://127.0.0.1:${hubPort}`;
  const appToken = "manager-onboarding-app-token";
  const socketUrl = hubOrigin.replace(/^http/u, "ws") + "/ws";

  let server = null;
  let socket = null;

  try {
    server = spawnProcess(process.execPath, ["server/index.js"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PORT: String(hubPort),
        APP_TOKEN: appToken,
        AGENT_TOKEN: "manager-onboarding-agent-token",
        DATA_FILE: dataFile,
        MANAGER_PROVIDER: "local",
      },
      label: "hub",
    });

    await waitForHealth(hubOrigin);

    socket = new WebSocket(socketUrl);
    await new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });

    socket.send(
      JSON.stringify({
        type: "hello",
        role: "app",
        token: appToken,
        appOrigin: hubOrigin,
      })
    );
    socket.send(
      JSON.stringify({
        type: "manager_message",
        text: "具体怎么接入一个新的 Codex 员工？",
      })
    );

    const assistantMessage = await waitForAssistantMessage(
      hubOrigin,
      appToken,
      (text) =>
        text.includes("npm run agent:onboard:codex") &&
        text.includes("npm run agent -- --config") &&
        text.includes(hubOrigin),
      15000
    );

    if (!assistantMessage.text.includes("grep '^AGENT_TOKEN=' .env")) {
      throw new Error("Manager onboarding smoke did not include AGENT_TOKEN lookup guidance.");
    }

    console.log("Manager onboarding smoke test passed.");
  } finally {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.close();
    }
    await stopProcess(server);
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message || "Manager onboarding smoke test failed.");
  process.exit(1);
});
