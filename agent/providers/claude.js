// Claude agent provider via idealab Anthropic-compatible API
// Supports tool calling (shell_exec, file_read, file_write, file_list) for agentic tasks
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

// Resolve API credentials: prefer explicit env vars, then fall back to MODELS_JSON
function resolveClaudeCredentials() {
  const envKey = process.env.ANTHROPIC_API_KEY;
  const envBase = process.env.ANTHROPIC_BASE_URL;
  if (envKey) return { apiKey: envKey, baseURL: envBase || "https://api.anthropic.com" };

  try {
    const models = JSON.parse(process.env.MODELS_JSON || "[]");
    const entry = (Array.isArray(models) ? models : []).find(
      (m) => m.provider === "anthropic" && m.apiKey
    );
    if (entry) return { apiKey: entry.apiKey, baseURL: entry.baseURL || "https://api.anthropic.com" };
  } catch {}

  return { apiKey: "", baseURL: "https://api.anthropic.com" };
}

const { apiKey: API_KEY, baseURL: BASE_URL } = resolveClaudeCredentials();

const MAX_TOOL_LOOPS = 15;

// ---------- Tool definitions ----------

const TOOLS = [
  {
    name: "shell_exec",
    description:
      "Execute a shell command and return stdout/stderr. Use for running builds, tests, git, etc. Working directory defaults to the conversation workdir.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to execute" },
        timeout_ms: {
          type: "number",
          description: "Timeout in milliseconds (default 60000)",
        },
      },
      required: ["command"],
    },
  },
  {
    name: "file_read",
    description: "Read a file and return its text content.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute or relative file path" },
      },
      required: ["path"],
    },
  },
  {
    name: "file_write",
    description:
      "Write content to a file (overwrites). Creates parent directories if needed.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute or relative file path" },
        content: { type: "string", description: "File content to write" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "file_list",
    description: "List files in a directory (non-recursive, max 200 entries).",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path" },
      },
      required: ["path"],
    },
  },
];

// ---------- Tool execution ----------

function executeTool(name, input, workdir) {
  const cwd = workdir || process.cwd();
  try {
    switch (name) {
      case "shell_exec": {
        const timeout = input.timeout_ms || 60_000;
        const result = execSync(input.command, {
          cwd,
          timeout,
          maxBuffer: 1024 * 1024,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env },
        });
        return result.slice(0, 20_000);
      }
      case "file_read": {
        const p = resolve(cwd, input.path);
        return readFileSync(p, "utf-8").slice(0, 50_000);
      }
      case "file_write": {
        const p = resolve(cwd, input.path);
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, input.content, "utf-8");
        return `Wrote ${input.content.length} bytes to ${p}`;
      }
      case "file_list": {
        const p = resolve(cwd, input.path);
        const entries = readdirSync(p).slice(0, 200);
        return entries
          .map((e) => {
            try {
              const s = statSync(resolve(p, e));
              return `${s.isDirectory() ? "d" : "-"} ${e}`;
            } catch {
              return `? ${e}`;
            }
          })
          .join("\n");
      }
      default:
        return `Unknown tool: ${name}`;
    }
  } catch (err) {
    return `Error: ${err.message}`.slice(0, 10_000);
  }
}

// ---------- Message builder ----------

function toClaudeMessages({ conversation, systemPrompt }) {
  const messages = [];

  for (const message of conversation.messages || []) {
    if (message.role === "assistant") {
      messages.push({ role: "assistant", content: message.text });
    } else if (message.role === "user") {
      messages.push({ role: "user", content: message.text });
    }
  }

  return { system: systemPrompt || "", messages };
}

// ---------- Runtime ----------

export function createClaudeRuntime({ model = "claude-opus-4-6", systemPrompt = "" } = {}) {
  return {
    id: "claude",
    capabilities: ["coding", "shell"],
    async getRegistrationContext() {
      return {};
    },
    async reply({ conversation, message }) {
      const workdir = conversation?.codexWorkdir || process.cwd();

      const activeConversation = message?.composedText
        ? {
            ...conversation,
            messages: (conversation.messages || []).map((item) =>
              item?.id === message.id ? { ...item, text: message.composedText } : item
            ),
          }
        : conversation;

      const { system, messages: initialMessages } = toClaudeMessages({
        conversation: activeConversation,
        systemPrompt,
      });

      let messages = initialMessages;
      let finalText = "";

      for (let loop = 0; loop < MAX_TOOL_LOOPS; loop++) {
        const response = await fetch(`${BASE_URL}/v1/messages`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": API_KEY,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model,
            max_tokens: 8192,
            system,
            messages,
            tools: TOOLS,
          }),
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Claude API failed: ${response.status} ${errorText}`);
        }

        const json = await response.json();
        const content = json.content || [];

        // Collect text
        const textParts = content
          .filter((b) => b.type === "text")
          .map((b) => b.text);
        if (textParts.length > 0) {
          finalText = textParts.join("\n");
        }

        // Check for tool_use
        const toolUseBlocks = content.filter((b) => b.type === "tool_use");
        if (toolUseBlocks.length === 0 || json.stop_reason !== "tool_use") {
          break;
        }

        // Append assistant turn (full content) to messages
        messages = [
          ...messages,
          { role: "assistant", content },
        ];

        // Execute tools and build tool_result blocks
        const toolResults = toolUseBlocks.map((block) => {
          const result = executeTool(block.name, block.input || {}, workdir);
          return {
            type: "tool_result",
            tool_use_id: block.id,
            content: result,
          };
        });

        messages = [
          ...messages,
          { role: "user", content: toolResults },
        ];
      }

      return {
        text: finalText || "任务已处理，但没有文本输出。",
      };
    },
  };
}
