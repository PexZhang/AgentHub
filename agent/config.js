import { promises as fs } from "fs";
import os from "os";
import { basename, dirname, join, resolve, sep } from "path";

export function normalizeText(value) {
  return String(value || "").trim();
}

export function normalizeWorkspaceKind(value) {
  const normalized = normalizeText(value).toLowerCase();
  return normalized || "repo";
}

export function slugify(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function resolvePathLike(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return "";
  }

  if (normalized === "~") {
    return os.homedir();
  }

  if (normalized.startsWith("~/")) {
    return join(os.homedir(), normalized.slice(2));
  }

  return resolve(normalized);
}

export function isPathWithinRoots(targetPath, roots = []) {
  const resolvedTarget = resolvePathLike(targetPath);
  if (!resolvedTarget) {
    return false;
  }

  const resolvedRoots = Array.isArray(roots)
    ? roots
        .map((root) => resolvePathLike(root))
        .filter(Boolean)
        .map((root) => resolve(root))
    : [];

  return resolvedRoots.some(
    (root) => resolvedTarget === root || resolvedTarget.startsWith(`${root}${sep}`)
  );
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function pushArgValue(target, key, value) {
  if (!(key in target)) {
    target[key] = value;
    return;
  }

  if (Array.isArray(target[key])) {
    target[key].push(value);
    return;
  }

  target[key] = [target[key], value];
}

export function parseCliArgs(argv = []) {
  const args = { _: [] };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (!token.startsWith("--")) {
      args._.push(token);
      continue;
    }

    const key = token.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      pushArgValue(args, key, next);
      index += 1;
      continue;
    }

    pushArgValue(args, key, true);
  }

  return args;
}

export function listArgValues(value) {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeText(item)).filter(Boolean);
  }

  const normalized = normalizeText(value);
  return normalized ? [normalized] : [];
}

function firstText(...values) {
  for (const value of values) {
    const normalized = normalizeText(value);
    if (normalized) {
      return normalized;
    }
  }

  return "";
}

function firstNumber(...values) {
  for (const value of values) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) {
      return numeric;
    }
  }

  return null;
}

function readConfigList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeText(item)).filter(Boolean);
  }

  const normalized = normalizeText(value);
  if (!normalized) {
    return [];
  }

  return normalized
    .split(",")
    .map((item) => normalizeText(item))
    .filter(Boolean);
}

function pickTextValue({ cliValue, fileValue, envValue, fallback = "", preferFile = false }) {
  const cliText = normalizeText(cliValue);
  if (cliText) {
    return cliText;
  }

  if (preferFile) {
    const fileText = normalizeText(fileValue);
    if (fileText) {
      return fileText;
    }

    const envText = normalizeText(envValue);
    if (envText) {
      return envText;
    }
  } else {
    const envText = normalizeText(envValue);
    if (envText) {
      return envText;
    }

    const fileText = normalizeText(fileValue);
    if (fileText) {
      return fileText;
    }
  }

  return fallback;
}

function pickNumberValue({ cliValue, fileValue, envValue, fallback = null, preferFile = false }) {
  const cliNumber = Number(cliValue);
  if (Number.isFinite(cliNumber) && cliNumber > 0) {
    return cliNumber;
  }

  const primary = preferFile ? Number(fileValue) : Number(envValue);
  if (Number.isFinite(primary) && primary > 0) {
    return primary;
  }

  const secondary = preferFile ? Number(envValue) : Number(fileValue);
  if (Number.isFinite(secondary) && secondary > 0) {
    return secondary;
  }

  return fallback;
}

async function readJsonFile(filePath) {
  const rawText = await fs.readFile(filePath, "utf8");
  const parsed = JSON.parse(rawText);
  if (!isObject(parsed)) {
    throw new Error("配置文件必须是 JSON 对象");
  }
  return parsed;
}

export async function loadAgentRuntimeConfig({ argv = process.argv.slice(2), env = process.env } = {}) {
  const args = parseCliArgs(argv);
  const explicitConfigPath = firstText(args.config, env.AGENT_CONFIG_FILE);
  const configPath = explicitConfigPath ? resolvePathLike(explicitConfigPath) : "";
  const fileConfig = configPath ? await readJsonFile(configPath) : {};
  const codexConfig = isObject(fileConfig.codex) ? fileConfig.codex : {};
  const preferFile = Boolean(configPath);

  return {
    configPath: configPath || null,
    hubOrigin:
      pickTextValue({
        cliValue: args.hub,
        fileValue: fileConfig.hubOrigin,
        envValue: env.HUB_ORIGIN,
        fallback: "http://localhost:3000",
        preferFile,
      }) || "http://localhost:3000",
    agentToken: pickTextValue({
      cliValue: args["agent-token"],
      fileValue: fileConfig.agentToken,
      envValue: env.AGENT_TOKEN,
      preferFile,
    }),
    agentId:
      pickTextValue({
        cliValue: args["agent-id"],
        fileValue: fileConfig.agentId,
        envValue: env.AGENT_ID,
        fallback: "local-ai",
        preferFile,
      }) || "local-ai",
    agentName:
      pickTextValue({
        cliValue: args["agent-name"],
        fileValue: fileConfig.agentName,
        envValue: env.AGENT_NAME,
        fallback: "Digital Employee",
        preferFile,
      }) || "Digital Employee",
    agentMode:
      pickTextValue({
        cliValue: firstText(args.runtime, args["agent-mode"]),
        fileValue: fileConfig.agentMode,
        envValue: env.AGENT_MODE,
        fallback: "echo",
        preferFile,
      }) || "echo",
    deviceId:
      pickTextValue({
        cliValue: args["device-id"],
        fileValue: fileConfig.deviceId,
        envValue: env.DEVICE_ID,
        fallback: os.hostname(),
        preferFile,
      }) || os.hostname(),
    deviceName:
      pickTextValue({
        cliValue: args["device-name"],
        fileValue: fileConfig.deviceName,
        envValue: env.DEVICE_NAME,
        preferFile,
      }) ||
      pickTextValue({
        cliValue: args["device-id"],
        fileValue: fileConfig.deviceId,
        envValue: env.DEVICE_ID,
        fallback: os.hostname(),
        preferFile,
      }) ||
      os.hostname(),
    agentVersion:
      pickTextValue({
        cliValue: args.version,
        fileValue: fileConfig.agentVersion,
        envValue: env.AGENT_VERSION,
        fallback: "1.0.0",
        preferFile,
      }) || "1.0.0",
    agentPrompt:
      pickTextValue({
        cliValue: args.prompt,
        fileValue: fileConfig.agentPrompt,
        envValue: env.AGENT_PROMPT,
        fallback:
          "你是 AgentHub 里的一个数字员工，要用简洁、可靠、可执行的方式帮助用户推进任务。",
        preferFile,
      }) ||
      "你是 AgentHub 里的一个数字员工，要用简洁、可靠、可执行的方式帮助用户推进任务。",
    heartbeatIntervalMs:
      pickNumberValue({
        cliValue: args["heartbeat-ms"],
        fileValue: fileConfig.heartbeatIntervalMs,
        envValue: env.AGENT_HEARTBEAT_INTERVAL_MS,
        fallback: 15000,
        preferFile,
      }) || 15000,
    defaultWorkspaceKind:
      pickTextValue({
        cliValue: args["workspace-kind"],
        fileValue: fileConfig.defaultWorkspaceKind,
        envValue: env.AGENT_DEFAULT_WORKSPACE_KIND,
        fallback: "repo",
        preferFile,
      }) || "repo",
    workdirRoots: (() => {
      const cliRoots = listArgValues(args.root).map((item) => resolvePathLike(item));
      if (cliRoots.length > 0) {
        return cliRoots;
      }

      const configRoots = readConfigList(fileConfig.workdirRoots).map((item) => resolvePathLike(item));
      const envRoots = readConfigList(env.AGENT_WORKDIR_ROOTS).map((item) => resolvePathLike(item));

      if (preferFile && configRoots.length > 0) {
        return configRoots;
      }

      if (!preferFile && envRoots.length > 0) {
        return envRoots;
      }

      if (!preferFile && configRoots.length > 0) {
        return configRoots;
      }

      if (preferFile && envRoots.length > 0) {
        return envRoots;
      }

      const codexWorkdir = resolvePathLike(
        pickTextValue({
          cliValue: args["codex-workdir"],
          fileValue: codexConfig.workdir,
          envValue: env.CODEX_WORKDIR,
          fallback: process.cwd(),
          preferFile,
        })
      );
      return codexWorkdir ? [codexWorkdir] : [process.cwd()];
    })(),
    workspaces: Array.isArray(fileConfig.workspaces) ? fileConfig.workspaces : [],
    agentWorkspacesFile: pickTextValue({
      cliValue: args["workspaces-file"],
      fileValue: fileConfig.agentWorkspacesFile,
      envValue: env.AGENT_WORKSPACES_FILE,
      preferFile,
    }),
    agentWorkspacesJson: pickTextValue({
      cliValue: args.workspaces,
      fileValue: fileConfig.agentWorkspacesJson,
      envValue: env.AGENT_WORKSPACES || env.AGENT_WORKSPACES_JSON,
      preferFile,
    }),
    openaiApiKey: pickTextValue({
      cliValue: args["openai-api-key"],
      fileValue: fileConfig.openaiApiKey,
      envValue: env.OPENAI_API_KEY,
      preferFile,
    }),
    openaiModel:
      pickTextValue({
        cliValue: args["openai-model"],
        fileValue: fileConfig.openaiModel,
        envValue: env.OPENAI_MODEL,
        fallback: "gpt-5",
        preferFile,
      }) || "gpt-5",
    codexBin:
      pickTextValue({
        cliValue: args["codex-bin"],
        fileValue: codexConfig.bin,
        envValue: env.CODEX_BIN,
        fallback: "codex",
        preferFile,
      }) || "codex",
    codexWorkdir:
      resolvePathLike(
        pickTextValue({
          cliValue: args["codex-workdir"],
          fileValue: codexConfig.workdir,
          envValue: env.CODEX_WORKDIR,
          fallback: process.cwd(),
          preferFile,
        })
      ) || process.cwd(),
    codexModel: pickTextValue({
      cliValue: args["codex-model"],
      fileValue: codexConfig.model,
      envValue: env.CODEX_MODEL,
      preferFile,
    }),
    codexSandbox:
      pickTextValue({
        cliValue: args["codex-sandbox"],
        fileValue: codexConfig.sandbox,
        envValue: env.CODEX_SANDBOX,
        fallback: "read-only",
        preferFile,
      }) || "read-only",
    codexHome:
      resolvePathLike(
        pickTextValue({
          cliValue: args["codex-home"],
          fileValue: codexConfig.home,
          envValue: env.CODEX_HOME,
          preferFile,
        })
      ) ||
      join(os.homedir(), ".codex"),
  };
}

export function parseWorkspaceCatalog(rawText, sourceLabel = "工作区配置") {
  try {
    const parsed = JSON.parse(rawText);
    if (!Array.isArray(parsed)) {
      throw new Error("工作区配置必须是 JSON 数组");
    }
    return parsed;
  } catch (error) {
    throw new Error(`${sourceLabel} 不是合法的工作区 JSON：${error.message}`);
  }
}

export async function loadConfiguredWorkspaceCatalog(runtimeConfig = {}) {
  const configItems = Array.isArray(runtimeConfig.workspaces) ? runtimeConfig.workspaces : [];
  if (configItems.length > 0) {
    return {
      items: configItems,
      sourceLabel: runtimeConfig.configPath ? `配置文件 ${runtimeConfig.configPath}` : "运行时配置",
    };
  }

  const rawJson = normalizeText(runtimeConfig.agentWorkspacesJson);
  if (rawJson) {
    return {
      items: parseWorkspaceCatalog(rawJson, "AGENT_WORKSPACES"),
      sourceLabel: "AGENT_WORKSPACES",
    };
  }

  const workspaceFile = resolvePathLike(runtimeConfig.agentWorkspacesFile);
  if (workspaceFile) {
    const rawText = await fs.readFile(workspaceFile, "utf8");
    return {
      items: parseWorkspaceCatalog(rawText, "AGENT_WORKSPACES_FILE"),
      sourceLabel: workspaceFile,
    };
  }

  return {
    items: [],
    sourceLabel: "默认工作区",
  };
}

export function buildWorkspaceId(deviceId, pathValue) {
  const seed = `${deviceId}-${pathValue}`;
  const slug = slugify(seed) || "workspace";
  return `workspace-${slug}`;
}

export function buildWorkspaceName(pathValue) {
  return basename(pathValue) || pathValue || "Workspace";
}

export function buildWorkspaceRecord({
  deviceId,
  runtime = "codex",
  path,
  kind = "repo",
  name = "",
  description = "",
  tags = [],
}) {
  const resolvedPath = resolvePathLike(path);
  const normalizedKind = normalizeWorkspaceKind(kind);
  const normalizedTags = Array.isArray(tags)
    ? tags.map((item) => normalizeText(item)).filter(Boolean)
    : [];

  return {
    id: buildWorkspaceId(deviceId, resolvedPath),
    name: normalizeText(name) || buildWorkspaceName(resolvedPath),
    path: resolvedPath,
    kind: normalizedKind,
    description: normalizeText(description) || null,
    tags: [...new Set(normalizedTags)],
    runtimeHints: runtime ? [runtime] : [],
  };
}

async function pathExists(pathValue) {
  try {
    await fs.access(pathValue);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(pathValue) {
  try {
    const stats = await fs.stat(pathValue);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

async function isGitRepo(pathValue) {
  return pathExists(join(pathValue, ".git"));
}

async function containsDocFiles(pathValue) {
  try {
    const entries = await fs.readdir(pathValue, { withFileTypes: true });
    return entries.some((entry) => {
      if (!entry.isFile()) {
        return false;
      }

      return /\.(md|mdx|txt|doc|docx|pdf)$/i.test(entry.name);
    });
  } catch {
    return false;
  }
}

async function listSubdirectories(pathValue) {
  try {
    const entries = await fs.readdir(pathValue, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => join(pathValue, entry.name));
  } catch {
    return [];
  }
}

function uniqueByPath(items) {
  const seen = new Set();
  const result = [];

  for (const item of items) {
    const resolvedPath = resolvePathLike(item.path);
    if (!resolvedPath || seen.has(resolvedPath)) {
      continue;
    }

    seen.add(resolvedPath);
    result.push({
      ...item,
      path: resolvedPath,
    });
  }

  return result;
}

export async function discoverSuggestedWorkspaces({
  roots = [],
  deviceId,
  runtime = "codex",
  fallbackKind = "repo",
} = {}) {
  const resolvedRoots = uniqueByPath(
    roots.map((pathValue) => ({ path: resolvePathLike(pathValue) })).filter((item) => item.path)
  ).map((item) => item.path);
  const discovered = [];

  for (const root of resolvedRoots) {
    if (!(await isDirectory(root))) {
      continue;
    }

    if (await isGitRepo(root)) {
      discovered.push(
        buildWorkspaceRecord({
          deviceId,
          runtime,
          path: root,
          kind: "repo",
          description: "Onboarding 自动识别出的 Git 仓库。",
          tags: ["auto-discovered", "repo"],
        })
      );
      continue;
    }

    const firstLevel = await listSubdirectories(root);
    const secondLevel = [];

    for (const directory of firstLevel) {
      if (await isGitRepo(directory)) {
        discovered.push(
          buildWorkspaceRecord({
            deviceId,
            runtime,
            path: directory,
            kind: "repo",
            description: "Onboarding 自动识别出的 Git 仓库。",
            tags: ["auto-discovered", "repo"],
          })
        );
        continue;
      }

      const nested = await listSubdirectories(directory);
      secondLevel.push(...nested);
    }

    for (const directory of secondLevel) {
      if (await isGitRepo(directory)) {
        discovered.push(
          buildWorkspaceRecord({
            deviceId,
            runtime,
            path: directory,
            kind: "repo",
            description: "Onboarding 自动识别出的 Git 仓库。",
            tags: ["auto-discovered", "repo"],
          })
        );
      }
    }

    const docsKind =
      /docs?|documents?|notes?|files?/i.test(basename(root)) || (await containsDocFiles(root))
        ? "docs"
        : normalizeWorkspaceKind(fallbackKind);

    if (!discovered.some((workspace) => workspace.path === root)) {
      discovered.push(
        buildWorkspaceRecord({
          deviceId,
          runtime,
          path: root,
          kind: docsKind,
          description:
            docsKind === "docs"
              ? "Onboarding 自动保留的文档工作区。"
              : "Onboarding 自动保留的默认工作区。",
          tags: ["auto-discovered", docsKind],
        })
      );
    }
  }

  return uniqueByPath(discovered);
}

export function buildDefaultCodexRoots() {
  const candidates = [
    process.cwd(),
    join(os.homedir(), "Codes"),
    join(os.homedir(), "code"),
    join(os.homedir(), "projects"),
    join(os.homedir(), "workspace"),
    join(os.homedir(), "Documents"),
  ];

  return uniqueByPath(candidates.map((path) => ({ path }))).map((item) => item.path);
}

export function parseWorkspaceArg(rawValue, { deviceId, runtime = "codex", defaultKind = "repo" }) {
  const [rawPath, rawName = "", rawKind = ""] = String(rawValue || "").split(":");
  const pathValue = resolvePathLike(rawPath);
  if (!pathValue) {
    return null;
  }

  return buildWorkspaceRecord({
    deviceId,
    runtime,
    path: pathValue,
    name: rawName,
    kind: rawKind || defaultKind,
    description: "Onboarding 手工添加的工作区。",
    tags: ["manual"],
  });
}

export function buildDefaultAgentConfigPath(agentId) {
  const slug = slugify(agentId || "codex-agent") || "codex-agent";
  return join(os.homedir(), ".agenthub", "employees", `${slug}.json`);
}

export async function writeAgentConfigFile(filePath, config) {
  const resolvedPath = resolvePathLike(filePath);
  await fs.mkdir(dirname(resolvedPath), { recursive: true });
  await fs.writeFile(resolvedPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return resolvedPath;
}
