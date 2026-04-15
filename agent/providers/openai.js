function toOpenAIInput({ conversation, systemPrompt }) {
  const items = [];

  if (systemPrompt) {
    items.push({ role: "system", content: systemPrompt });
  }

  for (const message of conversation.messages || []) {
    if (message.role === "assistant") {
      items.push({ role: "assistant", content: message.text });
      continue;
    }

    if (message.role === "user") {
      items.push({ role: "user", content: message.text });
    }
  }

  return items;
}

export function createOpenAIRuntime({ apiKey, model = "gpt-5", systemPrompt = "" } = {}) {
  return {
    id: "openai",
    capabilities: [],
    async getRegistrationContext() {
      return {};
    },
    async reply({ conversation }) {
      const response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          input: toOpenAIInput({
            conversation,
            systemPrompt,
          }),
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`OpenAI 请求失败: ${response.status} ${errorText}`);
      }

      const json = await response.json();
      return {
        text: json.output_text || "我收到了消息，但没有生成文本回复。",
      };
    },
  };
}
