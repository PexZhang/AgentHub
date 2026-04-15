import "dotenv/config";
import { spawnSync } from "child_process";
import { promises as fs } from "fs";
import { resolve } from "path";
import { pathToFileURL } from "url";
import {
  isPathWithinRoots,
  loadAgentRuntimeConfig,
  loadConfiguredWorkspaceCatalog,
  normalizeText,
  parseCliArgs,
  resolvePathLike,
} from "./config.js";

function printUsage() {
  console.log(`
AgentHub Employee Doctor

用法：
  node agent/doctor.js [选项]

常用参数：
  --config <path>        员工配置文件路径
  --agent-mode <mode>    临时覆盖运行时模式，例如 echo / codex / openai
  --json                 输出机器可读的 JSON 结果
  --timeout-ms <ms>      Hub 和运行时探测超时时间，默认 4000
  --help                 查看这份帮助

示例：
  npm run agent:doctor -- --config ~/.agenthub/employees/codex-office.json
  npm run agent:doctor -- --config ~/.agenthub/employees/codex-office.json --json
`);
}

function buildCheck(id, status, summary, details = null) {
  return {
    id,
    status,
    summary,
    details: details || null,
  };
}

function isDirectoryStats(stats) {
  return Boolean(stats) && typeof stats.isDirectory === "function" && stats.isDirectory();
}

async function statPath(pathValue) {
  try {
    return await fs.stat(pathValue);
  } catch {
    return null;
  }
}

async function fetchHealth(hubOrigin, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${hubOrigin.replace(/\/+$/, "")}/api/health`, {
      signal: controller.signal,
    });

    const rawText = await response.text();
    const payload = rawText ? JSON.parse(rawText) : {};
    return {
      ok: response.ok,
      status: response.status,
      payload,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function summarizeCommandResult(result) {
  const stdout = normalizeText(result?.stdout);
  const stderr = normalizeText(result?.stderr);
  return stdout.split("\n")[0] || stderr.split("\n")[0] || "";
}

async function inspectWorkspaces(runtimeConfig, workdirRoots) {
  const { items: declaredItems, sourceLabel } = await loadConfiguredWorkspaceCatalog(runtimeConfig);
  const fallbackWorkspace = {
    name: "Default Workspace",
    path: runtimeConfig.codexWorkdir || process.cwd(),
    kind: runtimeConfig.defaultWorkspaceKind || "repo",
    source: "default-workdir",
  };

  const candidates = declaredItems.length > 0 ? declaredItems : [fallbackWorkspace];
  const inspected = [];

  for (const item of candidates) {
    const rawPath = normalizeText(item?.path || item?.workdir);
    const resolvedPath = resolvePathLike(rawPath);
    const stats = resolvedPath ? await statPath(resolvedPath) : null;
    inspected.push({
      name: normalizeText(item?.name) || null,
      path: resolvedPath || rawPath || null,
      declaredPath: rawPath || null,
      exists: Boolean(stats),
      isDirectory: isDirectoryStats(stats),
      withinRoots: resolvedPath ? isPathWithinRoots(resolvedPath, workdirRoots) : false,
      kind: normalizeText(item?.kind) || null,
    });
  }

  return {
    sourceLabel,
    items: inspected,
  };
}

export async function runDoctor({ argv = process.argv.slice(2), env = process.env } = {}) {
  const args = parseCliArgs(argv);
  const timeoutMs = Math.max(1000, Number(args["timeout-ms"] || 4000));
  const runtimeConfig = await loadAgentRuntimeConfig({ argv, env });
  const checks = [];
  const workdirRoots = (Array.isArray(runtimeConfig.workdirRoots) ? runtimeConfig.workdirRoots : [])
    .map((item) => resolvePathLike(item))
    .filter(Boolean)
    .map((item) => resolve(item))
    .filter((item, index, all) => all.indexOf(item) === index);
  const codexWorkdir = resolvePathLike(runtimeConfig.codexWorkdir || process.cwd()) || process.cwd();

  if (!normalizeText(runtimeConfig.agentToken)) {
    checks.push(buildCheck("agent-token", "fail", "缺少 AGENT_TOKEN，员工无法回连 Hub。"));
  } else {
    checks.push(buildCheck("agent-token", "pass", "已检测到 AGENT_TOKEN。"));
  }

  if (!normalizeText(runtimeConfig.hubOrigin)) {
    checks.push(buildCheck("hub-origin", "fail", "缺少 Hub 地址。"));
  } else {
    try {
      const health = await fetchHealth(runtimeConfig.hubOrigin, timeoutMs);
      if (!health.ok) {
        checks.push(
          buildCheck(
            "hub-origin",
            "fail",
            `Hub 健康检查失败：${health.status}`,
            normalizeText(JSON.stringify(health.payload))
          )
        );
      } else {
        checks.push(
          buildCheck(
            "hub-origin",
            "pass",
            `Hub 可达：${runtimeConfig.hubOrigin}`,
            `onlineAgents=${Number(health.payload?.onlineAgents || 0)}`
          )
        );
      }
    } catch (error) {
      checks.push(
        buildCheck(
          "hub-origin",
          "fail",
          `无法连接 Hub：${runtimeConfig.hubOrigin}`,
          error.message || "health request failed"
        )
      );
    }
  }

  const identityWarnings = [];
  if (!normalizeText(runtimeConfig.deviceId)) {
    identityWarnings.push("deviceId");
  }
  if (!normalizeText(runtimeConfig.agentId)) {
    identityWarnings.push("agentId");
  }
  if (identityWarnings.length > 0) {
    checks.push(
      buildCheck(
        "identity",
        "fail",
        `员工身份不完整：缺少 ${identityWarnings.join(", ")}`,
        null
      )
    );
  } else {
    checks.push(
      buildCheck(
        "identity",
        "pass",
        `员工身份已就绪：${runtimeConfig.agentName} @ ${runtimeConfig.deviceName}`,
        `${runtimeConfig.agentId} on ${runtimeConfig.deviceId}`
      )
    );
  }

  if (workdirRoots.length === 0) {
    checks.push(buildCheck("workdir-roots", "fail", "没有可用的工作区根目录。"));
  } else {
    const missingRoots = [];
    const validRoots = [];

    for (const root of workdirRoots) {
      const stats = await statPath(root);
      if (isDirectoryStats(stats)) {
        validRoots.push(root);
      } else {
        missingRoots.push(root);
      }
    }

    if (validRoots.length === 0) {
      checks.push(
        buildCheck(
          "workdir-roots",
          "fail",
          "所有工作区根目录都不可用。",
          missingRoots.join(", ")
        )
      );
    } else if (missingRoots.length > 0) {
      checks.push(
        buildCheck(
          "workdir-roots",
          "warn",
          `工作区根目录部分可用：${validRoots.length} 个可用，${missingRoots.length} 个缺失。`,
          `missing=${missingRoots.join(", ")}`
        )
      );
    } else {
      checks.push(
        buildCheck(
          "workdir-roots",
          "pass",
          `工作区根目录可用：${validRoots.length} 个。`,
          validRoots.join(", ")
        )
      );
    }
  }

  const codexWorkdirStats = await statPath(codexWorkdir);
  if (!isDirectoryStats(codexWorkdirStats)) {
    checks.push(
      buildCheck("default-workdir", "fail", `默认工作目录不可用：${codexWorkdir}`)
    );
  } else if (!isPathWithinRoots(codexWorkdir, workdirRoots)) {
    checks.push(
      buildCheck(
        "default-workdir",
        "warn",
        `默认工作目录存在，但不在允许根目录内：${codexWorkdir}`,
        "目录浏览和自动工作区绑定可能不稳定。"
      )
    );
  } else {
    checks.push(buildCheck("default-workdir", "pass", `默认工作目录可用：${codexWorkdir}`));
  }

  const mode = normalizeText(runtimeConfig.agentMode) || "echo";
  if (mode === "codex") {
    const codexBin = normalizeText(runtimeConfig.codexBin) || "codex";
    const result = spawnSync(codexBin, ["--version"], {
      encoding: "utf8",
      timeout: timeoutMs,
      env,
    });

    if (result.error) {
      checks.push(
        buildCheck(
          "runtime",
          "fail",
          `Codex 运行时不可用：${codexBin}`,
          result.error.message || "spawn failed"
        )
      );
    } else if (result.status !== 0) {
      checks.push(
        buildCheck(
          "runtime",
          "fail",
          `Codex 运行时返回异常退出码：${result.status}`,
          summarizeCommandResult(result)
        )
      );
    } else {
      checks.push(
        buildCheck(
          "runtime",
          "pass",
          `Codex CLI 可用：${codexBin}`,
          summarizeCommandResult(result)
        )
      );
    }
  } else if (mode === "openai") {
    if (!normalizeText(runtimeConfig.openaiApiKey)) {
      checks.push(buildCheck("runtime", "fail", "OpenAI 模式缺少 OPENAI_API_KEY。"));
    } else {
      checks.push(
        buildCheck(
          "runtime",
          "pass",
          `OpenAI 运行时已配置：${runtimeConfig.openaiModel || "gpt-5"}`
        )
      );
    }
  } else if (mode === "echo") {
    checks.push(buildCheck("runtime", "pass", "Echo 运行时无需额外依赖。"));
  } else {
    checks.push(
      buildCheck(
        "runtime",
        "warn",
        `当前运行时 ${mode} 没有专用自检逻辑。`,
        "AgentHub 会继续尝试以这个模式启动。"
      )
    );
  }

  const workspaceReport = await inspectWorkspaces(runtimeConfig, workdirRoots);
  const missingWorkspacePaths = workspaceReport.items
    .filter((item) => !item.exists || !item.isDirectory)
    .map((item) => item.path || item.declaredPath || "未命名工作区");
  const outsideRootWorkspaces = workspaceReport.items
    .filter((item) => item.exists && item.isDirectory && !item.withinRoots)
    .map((item) => item.path);
  const validWorkspaces = workspaceReport.items.filter(
    (item) => item.exists && item.isDirectory && item.withinRoots
  );

  if (validWorkspaces.length === 0) {
    checks.push(
      buildCheck(
        "workspaces",
        "fail",
        "没有任何一个工作区能被当前员工稳定使用。",
        workspaceReport.items.map((item) => item.path || item.declaredPath || "未命名").join(", ")
      )
    );
  } else if (missingWorkspacePaths.length > 0 || outsideRootWorkspaces.length > 0) {
    const details = [];
    if (missingWorkspacePaths.length > 0) {
      details.push(`missing=${missingWorkspacePaths.join(", ")}`);
    }
    if (outsideRootWorkspaces.length > 0) {
      details.push(`outsideRoots=${outsideRootWorkspaces.join(", ")}`);
    }
    checks.push(
      buildCheck(
        "workspaces",
        "warn",
        `工作区部分可用：${validWorkspaces.length}/${workspaceReport.items.length} 个可正常使用。`,
        details.join(" | ")
      )
    );
  } else {
    checks.push(
      buildCheck(
        "workspaces",
        "pass",
        `工作区可用：${validWorkspaces.length} 个。`,
        `source=${workspaceReport.sourceLabel}`
      )
    );
  }

  const ready = checks.every((check) => check.status !== "fail");
  const status = ready
    ? checks.some((check) => check.status === "warn")
      ? "ready-with-warnings"
      : "ready"
    : "blocked";

  return {
    ready,
    status,
    configPath: runtimeConfig.configPath || null,
    identity: {
      deviceId: runtimeConfig.deviceId,
      deviceName: runtimeConfig.deviceName,
      agentId: runtimeConfig.agentId,
      agentName: runtimeConfig.agentName,
      agentMode: mode,
    },
    summary: {
      workspaceCount: validWorkspaces.length,
      declaredWorkspaceCount: workspaceReport.items.length,
      workdirRootCount: workdirRoots.length,
      checks: {
        pass: checks.filter((check) => check.status === "pass").length,
        warn: checks.filter((check) => check.status === "warn").length,
        fail: checks.filter((check) => check.status === "fail").length,
      },
    },
    checks,
    workspaces: workspaceReport,
  };
}

function printHumanResult(result) {
  console.log("");
  console.log("AgentHub Employee Doctor");
  console.log(`状态：${result.status}`);
  console.log(`员工：${result.identity.agentName} (${result.identity.agentId})`);
  console.log(`设备：${result.identity.deviceName} (${result.identity.deviceId})`);
  console.log(`模式：${result.identity.agentMode}`);
  if (result.configPath) {
    console.log(`配置：${result.configPath}`);
  }
  console.log("");

  for (const check of result.checks) {
    const icon = check.status === "pass" ? "PASS" : check.status === "warn" ? "WARN" : "FAIL";
    console.log(`[${icon}] ${check.summary}`);
    if (check.details) {
      console.log(`       ${check.details}`);
    }
  }

  console.log("");
  console.log(
    `工作区：${result.summary.workspaceCount}/${result.summary.declaredWorkspaceCount} 可用，根目录 ${result.summary.workdirRootCount} 个`
  );
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  const result = await runDoctor();

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printHumanResult(result);
  }

  process.exit(result.ready ? 0 : 1);
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  main().catch((error) => {
    console.error(error.message || "Agent doctor 执行失败。");
    process.exit(1);
  });
}
