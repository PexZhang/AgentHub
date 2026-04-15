function normalizeText(value) {
  return String(value || "").trim();
}

function baseSpec({
  name,
  description,
  properties = {},
  required = [],
}) {
  return {
    name,
    description,
    parameters: {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    },
    strict: true,
  };
}

function buildSpecs() {
  return [
    baseSpec({
      name: "list_employees",
      description: "列出当前有哪些数字员工，以及他们的在线状态和正在处理的任务。",
    }),
    baseSpec({
      name: "list_attention_items",
      description:
        "盘点当前最需要经理关注的异常或风险，例如阻塞任务、待审批、离线但任务未结束、长时间无更新。",
    }),
    baseSpec({
      name: "search_manager_knowledge",
      description:
        "查询 AgentHub 的内置经理知识库，用于回答平台规则、接入方式、职责边界、架构原理和扩展方法。",
      properties: {
        query: {
          type: "string",
          description: "用户原始问题，或要检索的知识主题。",
        },
      },
      required: ["query"],
    }),
    baseSpec({
      name: "get_onboarding_guide",
      description:
        "为新设备或新数字员工生成可执行的接入步骤和命令模板。用户问“具体怎么接入”“要敲什么命令”时优先使用。",
      properties: {
        runtime: {
          type: "string",
          description: "目标运行时，当前优先支持 codex。",
        },
      },
    }),
    baseSpec({
      name: "list_tasks",
      description: "列出当前任务与整体进度，用于回答谁在忙、谁卡住了、谁最需要关注。",
      properties: {
        employee_ref: {
          type: "string",
          description: "可选，限制为某位员工相关的任务。",
        },
        status: {
          type: "string",
          description: "可选，限制任务状态，例如 in_progress、waiting_approval、blocked、completed。",
        },
      },
    }),
    baseSpec({
      name: "get_task_status",
      description: "查询某一条具体任务的当前状态、负责人、工作区、最近进展和是否阻塞。",
      properties: {
        task_ref: {
          type: "string",
          description: "任务标题、任务 ID，或用户提到的任务线索。",
        },
      },
      required: ["task_ref"],
    }),
    baseSpec({
      name: "list_workspaces",
      description: "列出当前已接入的工作区、目录或仓库，帮助经理判断哪些员工能处理哪些目标。",
      properties: {
        employee_ref: {
          type: "string",
          description: "可选，只看某位员工名下的工作区。",
        },
      },
    }),
    baseSpec({
      name: "resolve_workspace_for_employee",
      description: "为某位员工定位一个工作区；如果没有明确匹配，也返回候选或自动选择结果。",
      properties: {
        employee_ref: {
          type: "string",
          description: "目标员工名字或 ID。",
        },
        workspace_ref: {
          type: "string",
          description: "可选，工作区名字、路径、仓库名或目录线索。",
        },
      },
      required: ["employee_ref"],
    }),
    baseSpec({
      name: "list_approvals",
      description: "列出当前等待审批的任务、原因和发起审批的数字员工。",
    }),
    baseSpec({
      name: "resolve_approval",
      description: "批准或拒绝一个待审批项。默认在上下文明确时处理最新的待审批项。",
      properties: {
        decision: {
          type: "string",
          enum: ["approved", "rejected"],
          description: "审批决定。",
        },
        approval_ref: {
          type: "string",
          description: "审批 ID、任务标题、审批原因或其他可识别线索。",
        },
        employee_ref: {
          type: "string",
          description: "发起审批的员工名字或 ID，可选。",
        },
        task_ref: {
          type: "string",
          description: "相关任务标题或 ID，可选。",
        },
        note: {
          type: "string",
          description: "给员工的补充说明，可选。",
        },
      },
      required: ["decision"],
    }),
    baseSpec({
      name: "assign_task_to_employee",
      description: "把一个新任务指派给某位数字员工，可选限制到某个工作区，并附带面向执行的任务标题或验收信号。",
      properties: {
        employee_ref: {
          type: "string",
          description: "目标员工名字或 ID。",
        },
        goal: {
          type: "string",
          description: "要交给员工推进的任务目标。",
        },
        workspace_ref: {
          type: "string",
          description: "可选，指定工作区名字、ID 或路径。",
        },
        task_title: {
          type: "string",
          description: "可选，更明确的任务标题。",
        },
        success_signal: {
          type: "string",
          description: "可选，告诉员工完成后应该产出什么结果或如何汇报。",
        },
      },
      required: ["employee_ref", "goal"],
    }),
    baseSpec({
      name: "get_employee_status",
      description: "查询某一位数字员工当前在做什么、进度到哪里、是否阻塞。",
      properties: {
        employee_ref: {
          type: "string",
          description: "员工名字、ID，或用户口头提到的员工称呼。",
        },
      },
      required: ["employee_ref"],
    }),
    baseSpec({
      name: "diagnose_employee_issue",
      description:
        "诊断某位数字员工的接入或执行异常，例如没接上、离线、没有工作区、任务久未更新或任务阻塞。",
      properties: {
        employee_ref: {
          type: "string",
          description: "员工名字、ID，或用户口头提到的员工称呼。",
        },
      },
      required: ["employee_ref"],
    }),
    baseSpec({
      name: "follow_up_with_employee",
      description:
        "代表经理向某位数字员工补充要求、催办或纠偏，不创建新任务，只发送一条跟进消息。",
      properties: {
        employee_ref: {
          type: "string",
          description: "要跟进的员工名字或 ID。",
        },
        message: {
          type: "string",
          description: "要发给员工的跟进内容。",
        },
        task_ref: {
          type: "string",
          description: "可选，关联某条任务，帮助定位正确的会话上下文。",
        },
      },
      required: ["employee_ref", "message"],
    }),
    baseSpec({
      name: "switch_to_employee_chat",
      description: "把用户切到和某位数字员工的直连会话。找不到会话时应自动打开该员工最近的会话或新建一个。",
      properties: {
        employee_ref: {
          type: "string",
          description: "要切换直连的员工名字或 ID。",
        },
      },
      required: ["employee_ref"],
    }),
  ];
}

function parseArguments(rawArguments) {
  if (!normalizeText(rawArguments)) {
    return {};
  }

  return JSON.parse(rawArguments);
}

export function createManagerToolRegistry(handlers = {}) {
  const specs = buildSpecs();
  const specMap = new Map(specs.map((spec) => [spec.name, spec]));

  return {
    getSpecs() {
      return specs;
    },
    buildResponsesTools() {
      return specs.map((tool) => ({
        type: "function",
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        strict: tool.strict,
      }));
    },
    buildChatCompletionTools() {
      return specs.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          strict: tool.strict,
        },
      }));
    },
    async execute(name, rawArguments) {
      const spec = specMap.get(name);
      if (!spec || typeof handlers[name] !== "function") {
        return {
          output: {
            ok: false,
            error: "UNKNOWN_TOOL",
            message: `未知工具: ${name}`,
          },
          clientAction: null,
        };
      }

      const args = parseArguments(rawArguments);
      return handlers[name](args);
    },
  };
}
