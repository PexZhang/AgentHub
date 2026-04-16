import { spawn } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { normalizeText, resolvePathLike, slugify } from "./config.js";

const DEFAULT_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

function xmlEscape(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function plistStrings(values = []) {
  return values.map((value) => `      <string>${xmlEscape(value)}</string>`).join("\n");
}

function plistDict(entries = {}) {
  return Object.entries(entries)
    .filter(([, value]) => normalizeText(value))
    .map(
      ([key, value]) =>
        `      <key>${xmlEscape(key)}</key>\n      <string>${xmlEscape(value)}</string>`
    )
    .join("\n");
}

async function runCommand(command, args = [], { allowFailure = false } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk || "");
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk || "");
    });

    child.on("error", (error) => {
      if (allowFailure) {
        resolvePromise({
          ok: false,
          stdout,
          stderr: stderr || error.message,
        });
        return;
      }

      rejectPromise(error);
    });

    child.on("exit", (code) => {
      if ((code ?? 0) === 0 || allowFailure) {
        resolvePromise({
          ok: (code ?? 0) === 0,
          stdout,
          stderr,
        });
        return;
      }

      rejectPromise(
        new Error(
          normalizeText(stderr) ||
            normalizeText(stdout) ||
            `${command} ${args.join(" ")} 执行失败，退出码 ${(code ?? 0).toString()}`
        )
      );
    });
  });
}

export function ensureLaunchdSupported() {
  if (process.platform !== "darwin") {
    throw new Error("开机后自动接入当前只支持 macOS（launchd）。");
  }
}

export function buildLaunchAgentLabel(agentId) {
  return `com.agenthub.employee.${slugify(agentId || "codex-agent") || "codex-agent"}`;
}

export function buildLaunchAgentPaths(agentId) {
  const label = buildLaunchAgentLabel(agentId);
  const homeDir = os.homedir();
  const launchAgentsDir = join(homeDir, "Library", "LaunchAgents");
  const logsDir = join(homeDir, ".agenthub", "logs");

  return {
    label,
    launchAgentsDir,
    logsDir,
    plistPath: join(launchAgentsDir, `${label}.plist`),
    stdoutPath: join(logsDir, `${label}.out.log`),
    stderrPath: join(logsDir, `${label}.err.log`),
  };
}

export function buildLaunchAgentPlist({
  label,
  configPath,
  agentScriptPath,
  stdoutPath,
  stderrPath,
  workingDirectory,
} = {}) {
  const environmentVariables = {
    PATH: normalizeText(process.env.PATH) || DEFAULT_PATH,
    HOME: os.homedir(),
    SHELL: normalizeText(process.env.SHELL) || "/bin/zsh",
    LANG: normalizeText(process.env.LANG) || "en_US.UTF-8",
  };
  const programArguments = [process.execPath, agentScriptPath, "--config", configPath];

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${xmlEscape(label)}</string>
    <key>ProgramArguments</key>
    <array>
${plistStrings(programArguments)}
    </array>
    <key>EnvironmentVariables</key>
    <dict>
${plistDict(environmentVariables)}
    </dict>
    <key>WorkingDirectory</key>
    <string>${xmlEscape(workingDirectory)}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ProcessType</key>
    <string>Background</string>
    <key>StandardOutPath</key>
    <string>${xmlEscape(stdoutPath)}</string>
    <key>StandardErrorPath</key>
    <string>${xmlEscape(stderrPath)}</string>
  </dict>
</plist>
`;
}

export async function installLaunchAgent({ configPath, agentId, loadNow = true } = {}) {
  ensureLaunchdSupported();

  const resolvedConfigPath = resolvePathLike(configPath);
  const normalizedAgentId = normalizeText(agentId);
  if (!resolvedConfigPath) {
    throw new Error("缺少可落盘的员工配置文件，无法安装开机自动接入。");
  }
  if (!normalizedAgentId) {
    throw new Error("缺少员工 id，无法安装开机自动接入。");
  }

  const paths = buildLaunchAgentPaths(normalizedAgentId);
  const agentScriptPath = join(dirname(fileURLToPath(import.meta.url)), "index.js");
  const workingDirectory = dirname(dirname(agentScriptPath));
  const plistContent = buildLaunchAgentPlist({
    ...paths,
    configPath: resolvedConfigPath,
    agentScriptPath,
    workingDirectory,
  });

  await fs.mkdir(paths.launchAgentsDir, { recursive: true });
  await fs.mkdir(paths.logsDir, { recursive: true });
  await fs.writeFile(paths.plistPath, plistContent, "utf8");

  if (loadNow) {
    const guiDomain = `gui/${process.getuid()}`;
    await runCommand("launchctl", ["bootout", guiDomain, paths.plistPath], {
      allowFailure: true,
    });
    await runCommand("launchctl", ["bootstrap", guiDomain, paths.plistPath]);
    await runCommand("launchctl", ["kickstart", "-k", `${guiDomain}/${paths.label}`], {
      allowFailure: true,
    });
  }

  return {
    ...paths,
    configPath: resolvedConfigPath,
    loaded: Boolean(loadNow),
  };
}

export async function uninstallLaunchAgent({ agentId } = {}) {
  ensureLaunchdSupported();

  const normalizedAgentId = normalizeText(agentId);
  if (!normalizedAgentId) {
    throw new Error("缺少员工 id，无法移除开机自动接入。");
  }

  const paths = buildLaunchAgentPaths(normalizedAgentId);
  const guiDomain = `gui/${process.getuid()}`;

  await runCommand("launchctl", ["bootout", guiDomain, paths.plistPath], {
    allowFailure: true,
  });
  await fs.rm(paths.plistPath, { force: true });

  return paths;
}

export async function readLaunchAgentStatus({ agentId } = {}) {
  ensureLaunchdSupported();

  const normalizedAgentId = normalizeText(agentId);
  if (!normalizedAgentId) {
    throw new Error("缺少员工 id，无法查看开机自动接入状态。");
  }

  const paths = buildLaunchAgentPaths(normalizedAgentId);
  const plistExists = await fs
    .access(paths.plistPath)
    .then(() => true)
    .catch(() => false);

  const guiDomain = `gui/${process.getuid()}`;
  const launchctlResult = await runCommand("launchctl", ["print", `${guiDomain}/${paths.label}`], {
    allowFailure: true,
  });

  return {
    ...paths,
    installed: plistExists,
    loaded: Boolean(launchctlResult.ok),
    launchctlOutput: normalizeText(launchctlResult.stdout || launchctlResult.stderr),
  };
}
