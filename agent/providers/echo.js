export function createEchoRuntime({
  agentName,
  fallbackHint = "如果你配置了真实运行时，这里会改为模型回复。",
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  return {
    id: "echo",
    capabilities: [],
    async getRegistrationContext() {
      return {};
    },
    async reply({ message }) {
      await sleep(300);
      return {
        text: [
          `已收到你的消息：${message.text}`,
          "",
          `这是 ${agentName} 在 AgentHub 里的最小版自动回复。`,
          fallbackHint,
        ].join("\n"),
      };
    },
  };
}
