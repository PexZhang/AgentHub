import { once } from "events";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { spawn } from "child_process";
import { setTimeout as delay } from "timers/promises";
import { JsonStore } from "../server/store/json-store.js";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function waitForHealth(baseUrl, attempts = 80) {
  for (let index = 0; index < attempts; index += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/health`, { cache: "no-store" });
      if (response.ok) {
        return response.json();
      }
    } catch {
      // Ignore boot race and retry.
    }

    await delay(150);
  }

  throw new Error("临时 AgentHub 实例没有按时启动。");
}

async function readJson(url, token, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.ok === false) {
    throw new Error(data?.message || `${url} 请求失败`);
  }

  return data;
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) {
    return;
  }

  child.kill("SIGTERM");
  await Promise.race([
    once(child, "exit"),
    delay(4000).then(() => {
      child.kill("SIGKILL");
    }),
  ]);
}

const tempRoot = await mkdtemp(join(tmpdir(), "agenthub-resource-smoke-"));
const dataFile = join(tempRoot, "state.json");
const resourceDir = join(tempRoot, "resources");
const port = 3860 + Math.floor(Math.random() * 300);
const token = "resource-smoke-token";
const serverStdout = [];
const serverStderr = [];

const initialState = {
  conversations: [],
  employees: [
    {
      id: "employee-codex",
      name: "Codex Smoke",
      deviceId: "device-smoke",
      deviceName: "Smoke Mac",
      runtime: "codex",
      status: "idle",
      online: false,
      updatedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    },
  ],
  workspaces: [],
  tasks: [],
  resources: [],
  taskResourceLinks: [],
  approvals: [],
  manager: {
    messages: [],
    provider: "local",
    model: "local-summary",
  },
};

await writeFile(dataFile, `${JSON.stringify(initialState, null, 2)}\n`, "utf8");

const server = spawn(process.execPath, ["server/index.js"], {
  cwd: "/Users/zhangpeng/ai-chat-mvp",
  env: {
    ...process.env,
    PORT: String(port),
    APP_TOKEN: token,
    DATA_FILE: dataFile,
    RESOURCE_STORAGE_DIR: resourceDir,
    MANAGER_PROVIDER: "local",
    MANAGER_MODEL: "local-summary",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

server.stdout.on("data", (chunk) => {
  serverStdout.push(String(chunk));
});
server.stderr.on("data", (chunk) => {
  serverStderr.push(String(chunk));
});

const baseUrl = `http://127.0.0.1:${port}`;

try {
  const health = await waitForHealth(baseUrl);
  assert(health.ok === true, "健康检查没有返回 ok");

  const upload = await readJson(`${baseUrl}/api/direct-message`, token, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      agentId: "employee-codex",
      text: "帮我分析这个 crash 文件",
      clientMessageId: "resource-smoke-message",
      files: [
        {
          name: "sample-crash.log",
          mime: "text/plain",
          text: [
            "CRASH HEADER",
            "thread main",
            "fatal signal 11",
            "stack frame 1",
            "stack frame 2",
            "tail marker",
          ].join("\n"),
        },
      ],
    }),
  });

  assert(upload.ok === true, "上传文本资源失败");
  assert(upload.attachments?.length === 1, "上传后没有返回附件引用");
  assert(upload.taskId, "上传后没有生成任务");
  assert(upload.conversationId, "上传后没有生成会话");

  const resourceId = upload.attachments[0]?.resourceId;
  assert(resourceId, "附件里缺少 resourceId");

  const resourceList = await readJson(`${baseUrl}/api/resources?q=sample-crash`, token);
  assert(resourceList.total === 1, "资源列表没有筛出刚上传的资源");

  const resourceByTag = await readJson(`${baseUrl}/api/resources?tag=crash`, token);
  assert(resourceByTag.total === 1, "按 crash 标签过滤资源失败");

  const resourceDetail = await readJson(`${baseUrl}/api/resources/${resourceId}`, token);
  assert(resourceDetail.resource?.id === resourceId, "资源详情返回了错误资源");
  assert(resourceDetail.resource?.primaryTaskId === upload.taskId, "资源没有和任务建立主关联");
  assert(resourceDetail.resource?.sourceConversationId === upload.conversationId, "资源没有绑定来源会话");
  assert(resourceDetail.resource?.taskCount === 1, "资源治理统计里的 taskCount 不正确");
  assert(resourceDetail.resource?.status === "in_use", "资源上传后应该处于使用中状态");

  const resourceHead = await readJson(
    `${baseUrl}/api/resources/${resourceId}/content?mode=head&limitLines=3`,
    token
  );
  assert(
    String(resourceHead.content || "").includes("CRASH HEADER"),
    "资源头部摘录没有读到预期内容"
  );

  const resourceTail = await readJson(
    `${baseUrl}/api/resources/${resourceId}/content?mode=tail&limitLines=2`,
    token
  );
  assert(
    String(resourceTail.content || "").includes("tail marker"),
    "资源尾部摘录没有读到预期内容"
  );

  const stateSnapshot = await readJson(`${baseUrl}/api/state`, token);
  const snapshotResource = (stateSnapshot.resources || []).find((item) => item.id === resourceId);
  assert(snapshotResource?.linkedTaskIds?.includes(upload.taskId), "快照里缺少任务到资源的反向关联");

  await stopServer(server);

  const store = new JsonStore({
    filePath: dataFile,
    resourceDir,
    managerProvider: "local",
    managerModel: "local-summary",
  });
  await store.init();
  await store.deleteConversation(upload.conversationId);
  const postDeleteSnapshot = store.buildSnapshot(new Map());
  const orphanedResource = (postDeleteSnapshot.resources || []).find((item) => item.id === resourceId);

  assert(orphanedResource, "删除会话后资源不应该被直接删除");
  assert(orphanedResource.orphaned === true, "删除会话后资源应该进入待清理状态");
  assert(orphanedResource.status === "orphaned", "删除会话后资源状态没有更新成 orphaned");

  console.log(
    [
      "resource governance smoke passed",
      `resource=${resourceId}`,
      `task=${upload.taskId}`,
      `conversation=${upload.conversationId}`,
    ].join(" | ")
  );
} catch (error) {
  console.error("resource governance smoke failed");
  console.error(error?.stack || error?.message || String(error));
  if (serverStdout.length > 0) {
    console.error("--- server stdout ---");
    console.error(serverStdout.join(""));
  }
  if (serverStderr.length > 0) {
    console.error("--- server stderr ---");
    console.error(serverStderr.join(""));
  }
  process.exitCode = 1;
} finally {
  await stopServer(server);
  await rm(tempRoot, { recursive: true, force: true });
}
