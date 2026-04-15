import assert from "assert/strict";
import { spawn } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import { join } from "path";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomPort() {
  return 3200 + Math.floor(Math.random() * 500);
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

  throw new Error("Onboarding smoke test timed out while waiting for Hub health.");
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

  throw new Error("Onboarding smoke test timed out while waiting for an online agent.");
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
  const tempRoot = await fs.mkdtemp(join(os.tmpdir(), "agenthub-onboard-"));
  const dataFile = join(tempRoot, "state.json");
  const configPath = join(tempRoot, "codex-office.json");
  const repoWorkspace = join(tempRoot, "Codes", "demo-repo");
  const docsWorkspace = join(tempRoot, "Documents");
  const hubPort = randomPort();
  const hubOrigin = `http://127.0.0.1:${hubPort}`;
  const appToken = "smoke-app-token";
  const agentToken = "smoke-agent-token";

  let server = null;
  let agent = null;

  try {
    await fs.mkdir(join(repoWorkspace, ".git"), { recursive: true });
    await fs.mkdir(docsWorkspace, { recursive: true });
    await fs.writeFile(join(docsWorkspace, "brief.md"), "# Smoke docs\n", "utf8");

    server = spawnProcess(process.execPath, ["server/index.js"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PORT: String(hubPort),
        APP_TOKEN: appToken,
        AGENT_TOKEN: agentToken,
        DATA_FILE: dataFile,
      },
      label: "hub",
    });

    await waitForHealth(hubOrigin);

    await runCommand(
      process.execPath,
      [
        "agent/onboard.js",
        "--hub",
        hubOrigin,
        "--agent-token",
        agentToken,
        "--device-name",
        "Smoke Device",
        "--agent-name",
        "Smoke Codex",
        "--root",
        join(tempRoot, "Codes"),
        "--root",
        docsWorkspace,
        "--config",
        configPath,
        "--overwrite",
      ],
      {
        cwd: repoRoot,
        env: process.env,
        label: "onboard",
      }
    );

    const doctorOutput = await runCommand(
      process.execPath,
      ["agent/doctor.js", "--config", configPath, "--agent-mode", "echo", "--json"],
      {
        cwd: repoRoot,
        env: process.env,
        label: "doctor",
      }
    );
    const doctor = JSON.parse(doctorOutput.stdout);
    assert.equal(doctor.ready, true, "doctor should pass");
    assert.ok(doctor.summary.workspaceCount >= 1, "doctor should detect at least one workspace");

    agent = spawnProcess(
      process.execPath,
      ["agent/index.js", "--config", configPath, "--agent-mode", "echo"],
      {
        cwd: repoRoot,
        env: process.env,
        label: "agent",
      }
    );

    await waitForOnlineAgent(hubOrigin, appToken);

    await runCommand(process.execPath, ["scripts/smoke-test.js"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        HUB_ORIGIN: hubOrigin,
        APP_TOKEN: appToken,
      },
      label: "smoke",
    });

    console.log("Onboarding smoke test passed.");
  } finally {
    await stopProcess(agent);
    await stopProcess(server);
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message || "Onboarding smoke test failed.");
  process.exit(1);
});
