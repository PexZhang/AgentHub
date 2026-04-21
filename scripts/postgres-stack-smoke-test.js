import assert from "assert/strict";
import { spawn } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import { join } from "path";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomPort() {
  return 3900 + Math.floor(Math.random() * 500);
}

function randomSuffix() {
  return Math.random().toString(36).slice(2, 8);
}

function requireDatabaseUrl() {
  const value = String(process.env.DATABASE_URL || "").trim();
  if (!value) {
    throw new Error("Postgres stack smoke test 需要提供 DATABASE_URL。");
  }
  return value;
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

async function runCommand(command, args, { cwd, env, label }) {
  const child = spawnProcess(command, args, { cwd, env, label });

  return new Promise((resolvePromise, rejectPromise) => {
    child.on("exit", (code) => {
      if ((code ?? 0) === 0) {
        resolvePromise(child.getOutput());
        return;
      }

      const output = child.getOutput();
      rejectPromise(
        new Error(
          `${label || command} exited with code ${code}\nSTDOUT:\n${output.stdout}\nSTDERR:\n${output.stderr}`
        )
      );
    });

    child.on("error", (error) => {
      rejectPromise(error);
    });
  });
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
      // server not ready yet
    }

    await sleep(250);
  }

  throw new Error("Postgres stack smoke timed out while waiting for Hub health.");
}

async function waitForOnlineAgent(hubOrigin, appToken, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${hubOrigin}/api/state`, {
        headers: {
          "x-agenthub-token": appToken,
        },
      });

      if (response.ok) {
        const snapshot = await response.json();
        const onlineAgent = (snapshot.agents || []).find((agent) => agent.online);
        if (onlineAgent) {
          return onlineAgent;
        }
      }
    } catch {
      // agent or hub not ready yet
    }

    await sleep(250);
  }

  throw new Error("Postgres stack smoke timed out while waiting for an online agent.");
}

async function fetchSnapshot(hubOrigin, appToken) {
  const response = await fetch(`${hubOrigin}/api/state`, {
    headers: {
      "x-agenthub-token": appToken,
    },
  });

  if (!response.ok) {
    throw new Error(`读取状态失败: ${response.status}`);
  }

  return response.json();
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
  const tempRoot = await fs.mkdtemp(join(os.tmpdir(), "agenthub-pg-stack-"));
  const dataFile = join(tempRoot, "state.json");
  const databaseUrl = requireDatabaseUrl();
  const stateKey = `smoke-${randomSuffix()}`;
  const appToken = "postgres-smoke-app-token";
  const agentToken = "postgres-smoke-agent-token";
  const sourcePort = randomPort();
  const pgPort = sourcePort + 1;
  const sourceHubOrigin = `http://127.0.0.1:${sourcePort}`;
  const postgresHubOrigin = `http://127.0.0.1:${pgPort}`;

  let sourceHub = null;
  let sourceAgent = null;
  let postgresHub = null;
  let postgresAgent = null;

  try {
    sourceHub = spawnProcess(process.execPath, ["server/index.js"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PORT: String(sourcePort),
        APP_TOKEN: appToken,
        AGENT_TOKEN: agentToken,
        DATA_FILE: dataFile,
        MANAGER_PROVIDER: "local",
      },
      label: "source-hub",
    });

    await waitForHealth(sourceHubOrigin);

    sourceAgent = spawnProcess(
      process.execPath,
      [
        "agent/index.js",
        "--hub",
        sourceHubOrigin,
        "--agent-token",
        agentToken,
        "--device-name",
        "Postgres Smoke Device",
        "--agent-name",
        "Postgres Smoke Agent",
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
        label: "source-agent",
      }
    );

    await waitForOnlineAgent(sourceHubOrigin, appToken);

    await runCommand(process.execPath, ["scripts/smoke-test.js"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        HUB_ORIGIN: sourceHubOrigin,
        APP_TOKEN: appToken,
      },
      label: "source-smoke",
    });

    await stopProcess(sourceAgent);
    sourceAgent = null;
    await stopProcess(sourceHub);
    sourceHub = null;

    await runCommand(process.execPath, ["scripts/db-migrate.js"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
      },
      label: "db-migrate",
    });

    await runCommand(process.execPath, ["scripts/db-import-json.js"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        DATA_FILE: dataFile,
        STORE_PG_STATE_KEY: stateKey,
      },
      label: "db-import-json",
    });

    postgresHub = spawnProcess(process.execPath, ["server/index.js"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PORT: String(pgPort),
        APP_TOKEN: appToken,
        AGENT_TOKEN: agentToken,
        STORE_DRIVER: "postgres",
        DATABASE_URL: databaseUrl,
        STORE_PG_STATE_KEY: stateKey,
        MANAGER_PROVIDER: "local",
      },
      label: "postgres-hub",
    });

    await waitForHealth(postgresHubOrigin);

    const importedSnapshot = await fetchSnapshot(postgresHubOrigin, appToken);
    assert.ok(
      (importedSnapshot.conversations || []).length >= 1,
      "imported postgres snapshot should include at least one conversation"
    );

    postgresAgent = spawnProcess(
      process.execPath,
      [
        "agent/index.js",
        "--hub",
        postgresHubOrigin,
        "--agent-token",
        agentToken,
        "--device-name",
        "Postgres Smoke Device",
        "--agent-name",
        "Postgres Smoke Agent",
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
        label: "postgres-agent",
      }
    );

    await waitForOnlineAgent(postgresHubOrigin, appToken);

    await runCommand(process.execPath, ["scripts/smoke-test.js"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        HUB_ORIGIN: postgresHubOrigin,
        APP_TOKEN: appToken,
      },
      label: "postgres-smoke",
    });

    console.log("Postgres stack smoke test passed.");
  } finally {
    await stopProcess(postgresAgent);
    await stopProcess(postgresHub);
    await stopProcess(sourceAgent);
    await stopProcess(sourceHub);
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message || "Postgres stack smoke test failed.");
  process.exit(1);
});
