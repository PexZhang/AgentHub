import { loadAgentRuntimeConfig, parseCliArgs } from "./config.js";
import { installLaunchAgent, readLaunchAgentStatus, uninstallLaunchAgent } from "./launchd.js";

function printUsage() {
  console.log(`
AgentHub macOS 开机自动接入

用法：
  npm run agent:autostart:install -- --config ~/.agenthub/employees/codex-main.json [选项]

常用参数：
  --config <path>      员工配置文件路径
  --write-only         只写 LaunchAgent，不立即加载
  --status             查看当前自动接入状态
  --uninstall          移除当前员工的自动接入
  --help               查看帮助

示例：
  npm run agent:autostart:install -- --config ~/.agenthub/employees/codex-main.json
  npm run agent:autostart:install -- --config ~/.agenthub/employees/codex-main.json --status
  npm run agent:autostart:install -- --config ~/.agenthub/employees/codex-main.json --uninstall
`);
}

async function main() {
  const argv = process.argv.slice(2);
  const args = parseCliArgs(argv);

  if (args.help) {
    printUsage();
    return;
  }

  const runtimeConfig = await loadAgentRuntimeConfig({ argv });
  if (!runtimeConfig.configPath) {
    throw new Error("请通过 --config 指定员工配置文件，再安装开机自动接入。");
  }

  if (args.status) {
    const status = await readLaunchAgentStatus({
      agentId: runtimeConfig.agentId,
    });

    console.log(`员工：${runtimeConfig.agentName} (${runtimeConfig.agentId})`);
    console.log(`配置：${runtimeConfig.configPath}`);
    console.log(`已安装：${status.installed ? "是" : "否"}`);
    console.log(`已加载：${status.loaded ? "是" : "否"}`);
    console.log(`LaunchAgent：${status.plistPath}`);
    console.log(`日志：${status.stdoutPath}`);
    if (status.launchctlOutput) {
      console.log("");
      console.log(status.launchctlOutput);
    }
    return;
  }

  if (args.uninstall) {
    const removed = await uninstallLaunchAgent({
      agentId: runtimeConfig.agentId,
    });

    console.log(`已移除开机自动接入：${removed.plistPath}`);
    return;
  }

  const installed = await installLaunchAgent({
    configPath: runtimeConfig.configPath,
    agentId: runtimeConfig.agentId,
    loadNow: !args["write-only"],
  });

  console.log(`已安装开机自动接入：${installed.plistPath}`);
  console.log(`员工：${runtimeConfig.agentName} (${runtimeConfig.agentId})`);
  console.log(`Hub：${runtimeConfig.hubOrigin}`);
  console.log(`日志：${installed.stdoutPath}`);
  if (installed.loaded) {
    console.log("当前会话已立即加载，之后开机登录也会自动接回 AgentHub。");
  } else {
    console.log("当前只写入了 LaunchAgent；下次登录时会自动接回 AgentHub。");
  }
}

main().catch((error) => {
  console.error(error.message || "安装开机自动接入失败。");
  process.exit(1);
});
