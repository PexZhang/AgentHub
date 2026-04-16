import { spawn } from "child_process";
import { promises as fs } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import {
  buildDefaultAgentConfigPath,
  buildDefaultCodexRoots,
  buildWorkspaceRecord,
  discoverSuggestedWorkspaces,
  listArgValues,
  normalizeText,
  parseCliArgs,
  parseWorkspaceArg,
  resolvePathLike,
  slugify,
  writeAgentConfigFile,
} from "./config.js";
import { installLaunchAgent } from "./launchd.js";

function printUsage() {
  console.log(`
AgentHub Codex Onboarding

用法：
  node agent/onboard.js --hub http://localhost:3000 --agent-token <token> [选项]

常用参数：
  --hub <url>                 Hub 地址
  --agent-token <token>       AGENT_TOKEN
  --device-name <name>        设备展示名
  --device-id <id>            设备稳定 id，默认从设备名生成
  --agent-name <name>         员工展示名，默认 Codex Agent
  --agent-id <id>             员工稳定 id，默认从员工名生成
  --root <path>               让 onboarding 在这些根目录下自动发现工作区，可重复
  --workspace <path[:name[:kind]]>
                              手工补充工作区，可重复
  --config <path>             输出配置文件路径
  --dry-run                   只打印将要写入的配置，不落盘
  --doctor                    写完配置后立即执行一次员工自检
  --start                     写完后立即启动这个 Codex 员工
  --autostart                 安装为 macOS 登录自启，并立即加载
  --overwrite                 覆盖已有配置文件

示例：
  npm run agent:onboard:codex -- --hub http://127.0.0.1:3000 --agent-token demo --device-name "Office Mac" --agent-name "Codex Office" --root ~/Codes --start
`);
}

function firstArgText(args, key, fallback = "") {
  const values = listArgValues(args[key]);
  return values[0] || fallback;
}

function ensureValue(value, label) {
  const normalized = normalizeText(value);
  if (!normalized) {
    throw new Error(`${label} 不能为空`);
  }
  return normalized;
}

function dedupeWorkspaces(workspaces) {
  const seen = new Set();
  const result = [];

  for (const workspace of workspaces) {
    const pathValue = normalizeText(workspace?.path);
    if (!pathValue || seen.has(pathValue)) {
      continue;
    }

    seen.add(pathValue);
    result.push(workspace);
  }

  return result;
}

function buildStableId(seed, fallback) {
  const slug = slugify(seed);
  return slug || fallback;
}

async function pathExists(pathValue) {
  try {
    await fs.access(pathValue);
    return true;
  } catch {
    return false;
  }
}

async function runDoctorCheck(configPath) {
  const doctorScriptPath = join(dirname(fileURLToPath(import.meta.url)), "doctor.js");

  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [doctorScriptPath, "--config", configPath], {
      cwd: process.cwd(),
      stdio: "inherit",
      env: process.env,
    });

    child.on("exit", (code) => {
      if ((code ?? 0) === 0) {
        resolvePromise();
        return;
      }

      rejectPromise(new Error("员工自检未通过，请先修复后再启动。"));
    });

    child.on("error", (error) => {
      rejectPromise(error);
    });
  });
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));

  if (args.help) {
    printUsage();
    return;
  }

  const hubOrigin = ensureValue(firstArgText(args, "hub"), "Hub 地址");
  const agentToken = ensureValue(firstArgText(args, "agent-token"), "AGENT_TOKEN");
  const deviceName = firstArgText(args, "device-name", normalizeText(process.env.DEVICE_NAME)) || "Local Device";
  const deviceId =
    firstArgText(args, "device-id", normalizeText(process.env.DEVICE_ID)) ||
    buildStableId(deviceName, "local-device");
  const agentName =
    firstArgText(args, "agent-name", normalizeText(process.env.AGENT_NAME)) || "Codex Agent";
  const agentId =
    firstArgText(args, "agent-id", normalizeText(process.env.AGENT_ID)) ||
    buildStableId(agentName, "codex-agent");
  const codexWorkdir = resolvePathLike(
    firstArgText(args, "codex-workdir", process.cwd()) || process.cwd()
  );
  const requestedRoots = listArgValues(args.root).map((item) => resolvePathLike(item));
  const roots = requestedRoots.length > 0 ? requestedRoots : buildDefaultCodexRoots();
  const manualWorkspaces = listArgValues(args.workspace)
    .map((value) =>
      parseWorkspaceArg(value, {
        deviceId,
        runtime: "codex",
        defaultKind: "repo",
      })
    )
    .filter(Boolean);
  const discoveredWorkspaces = await discoverSuggestedWorkspaces({
    roots,
    deviceId,
    runtime: "codex",
    fallbackKind: "repo",
  });
  const combinedWorkspaces = dedupeWorkspaces([
    ...manualWorkspaces,
    ...discoveredWorkspaces,
  ]);

  if (combinedWorkspaces.length === 0) {
    combinedWorkspaces.push(
      buildWorkspaceRecord({
        deviceId,
        runtime: "codex",
        path: codexWorkdir,
        kind: "repo",
        description: "Onboarding 兜底保留的默认 Codex 工作目录。",
        tags: ["fallback"],
      })
    );
  }

  const configPath =
    resolvePathLike(firstArgText(args, "config")) || buildDefaultAgentConfigPath(agentId);
  const config = {
    schemaVersion: "agenthub.employee-config.v1",
    hubOrigin,
    agentToken,
    deviceId,
    deviceName,
    agentId,
    agentName,
    agentMode: "codex",
    agentVersion: "1.0.0",
    heartbeatIntervalMs: 15000,
    defaultWorkspaceKind: "repo",
    workdirRoots: roots,
    codex: {
      bin: firstArgText(args, "codex-bin", process.env.CODEX_BIN || "codex"),
      workdir: codexWorkdir,
      model: firstArgText(args, "codex-model", process.env.CODEX_MODEL),
      sandbox: firstArgText(args, "codex-sandbox", process.env.CODEX_SANDBOX || "read-only"),
      home: firstArgText(args, "codex-home", process.env.CODEX_HOME),
    },
    workspaces: combinedWorkspaces,
  };

  if (args["dry-run"]) {
    console.log(JSON.stringify({ configPath, config }, null, 2));
    return;
  }

  if (!args.overwrite && (await pathExists(configPath))) {
    throw new Error(`配置文件已存在：${configPath}。如果你确认要覆盖，请加 --overwrite`);
  }

  const resolvedConfigPath = await writeAgentConfigFile(configPath, config);

  console.log(`已生成 Codex 员工配置：${resolvedConfigPath}`);
  console.log(`设备：${deviceName} (${deviceId})`);
  console.log(`员工：${agentName} (${agentId})`);
  console.log("工作区：");
  combinedWorkspaces.forEach((workspace, index) => {
    console.log(`  ${index + 1}. ${workspace.name} [${workspace.kind}] ${workspace.path}`);
  });
  console.log("");
  console.log("启动方式：");
  console.log(`  npm run agent -- --config ${resolvedConfigPath}`);
  console.log("自检方式：");
  console.log(`  npm run agent:doctor -- --config ${resolvedConfigPath}`);
  console.log("开机自动接入：");
  console.log(`  npm run agent:autostart:install -- --config ${resolvedConfigPath}`);

  if (args.doctor || args.start || args.autostart) {
    console.log("");
    console.log("正在执行员工自检...");
    await runDoctorCheck(resolvedConfigPath);
  }

  if (args.autostart) {
    console.log("");
    console.log("正在安装 macOS 登录自启...");
    const launchAgent = await installLaunchAgent({
      configPath: resolvedConfigPath,
      agentId,
      loadNow: true,
    });
    console.log(`已安装开机自动接入：${launchAgent.plistPath}`);
    console.log(`日志：${launchAgent.stdoutPath}`);

    if (args.start) {
      console.log("已通过 launchd 立即拉起员工进程，跳过当前前台启动。");
      return;
    }
  }

  if (args.start) {
    console.log("");
    console.log("正在启动这个 Codex 员工...");
    const agentScriptPath = join(dirname(fileURLToPath(import.meta.url)), "index.js");

    const child = spawn(process.execPath, [agentScriptPath, "--config", resolvedConfigPath], {
      cwd: process.cwd(),
      stdio: "inherit",
      env: process.env,
    });

    child.on("exit", (code) => {
      process.exit(code ?? 0);
    });
    return;
  }
}

main().catch((error) => {
  console.error(error.message || "Codex onboarding 失败。");
  process.exit(1);
});
