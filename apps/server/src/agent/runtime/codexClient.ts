import { spawn } from "node:child_process";
import { join } from "node:path";
import { networkInterfaces } from "node:os";
import type { Request } from "express";
import { readdir, stat } from "@toonflow/file";
import { isMobileLinkRequest } from "@/utils/mobileLink";

export type CodexMessage = { id?: number | string; method?: string; params?: Record<string, any>; result?: any; error?: { message: string } };

export function requireLocalCodexRequest(req: Request) {
  const address = req.socket.remoteAddress?.replace(/^::ffff:/, "");
  const local = new Set(["127.0.0.1", "::1", ...Object.values(networkInterfaces()).flatMap(items => items?.map(item => item.address) ?? [])]);
  const origin = req.get("origin");
  const sameOrigin = !origin || origin === `${req.protocol}://${req.get("host")}`;
  if (!address || !local.has(address) || !sameOrigin || req.get("x-toonflow-workspace") !== "1"
    || req.get("x-toonflow-local-client") === "0" || isMobileLinkRequest(req)) {
    throw Object.assign(new Error("本机 Codex CLI 仅允许此电脑的 Toonflow 页面使用"), { status: 403 });
  }
}

async function findCodex() {
  const configured = process.env.TOONFLOW_CODEX_PATH;
  if (configured) {
    if (!(await stat(configured)).isFile()) throw new Error("TOONFLOW_CODEX_PATH 必须指向 Codex CLI 文件");
    return configured;
  }
  const executable = Bun.which("codex");
  if (executable) return executable;
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    const directory = join(process.env.LOCALAPPDATA, "OpenAI", "Codex", "bin");
    const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const candidates = await Promise.all(entries.filter(entry => entry.isDirectory()).map(async entry => {
      const path = join(directory, entry.name, "codex.exe");
      const info = await stat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      return info?.isFile() ? { path, modified: info.mtimeMs } : undefined;
    }));
    const latest = candidates.filter(item => item !== undefined).sort((a, b) => b.modified - a.modified)[0];
    if (latest) return latest.path;
  }
  throw new Error("未找到本机 Codex CLI，请安装并执行 codex login，或设置 TOONFLOW_CODEX_PATH");
}

// ACT: 每个运行中的画布对话独立持有 stdio 子进程；仅关闭自己创建的进程。
// Codex 原生会话由 CLI 持久化，下次通过 thread/resume 恢复，不读取或复制登录令牌。
export async function createCodexClient(cwd: string, onMessage: (message: CodexMessage) => void | Promise<void> = () => {}) {
  const executable = await findCodex();
  const child = spawn(executable, ["app-server", "--listen", "stdio://"], { cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  let sequence = 0;
  let buffer = "";
  let stopped: Error | undefined;
  const fail = (error: Error) => {
    if (stopped) return;
    stopped = error;
    for (const call of pending.values()) { clearTimeout(call.timer); call.reject(error); }
    pending.clear();
    void Promise.resolve(onMessage({ method: "client/closed", params: { message: error.message } })).catch(() => {});
  };
  const send = (message: CodexMessage) => {
    if (stopped) throw stopped;
    child.stdin.write(JSON.stringify(message) + "\n");
  };
  const client = {
    request<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      if (stopped) return Promise.reject(stopped);
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Codex 接口超时：${method}`)); }, 60000);
        pending.set(id, { resolve, reject, timer });
        try { send({ id, method, params }); }
        catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
      });
    },
    respond(id: number | string, result: unknown) { send({ id, result }); },
    close() {
      fail(new Error("Codex 本轮连接已关闭"));
      child.stdin.end();
      child.kill();
    },
  };
  child.on("error", () => fail(new Error("Codex CLI 启动失败，请检查本机安装路径")));
  child.on("exit", code => fail(new Error(`Codex CLI 已退出（${code ?? "已停止"}）`)));
  child.stdin.on("error", () => fail(new Error("Codex CLI 输入通道已关闭")));
  // 不把 CLI 诊断日志发送到浏览器，避免泄露本机路径、账户或工具的私有内容。
  child.stderr.resume();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    if (buffer.length > 64 * 1024 * 1024) { fail(new Error("Codex 返回了过大的协议消息")); child.kill(); return; }
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      let message: CodexMessage;
      try { message = JSON.parse(line); }
      catch { fail(new Error("Codex CLI 返回的 JSON 协议无效")); child.kill(); return; }
      const call = typeof message.id === "number" && !message.method ? pending.get(message.id) : undefined;
      if (call) {
        pending.delete(message.id as number); clearTimeout(call.timer);
        if (message.error) call.reject(new Error(message.error.message));
        else call.resolve(message.result);
      } else {
        void Promise.resolve(onMessage(message)).catch(error => fail(error instanceof Error ? error : new Error("Codex 事件处理失败")));
      }
    }
  });
  try {
    await client.request("initialize", { clientInfo: { name: "toonflow_local", title: "Toonflow Local", version: "0.1.0" }, capabilities: { experimentalApi: true } });
    send({ method: "initialized", params: {} });
    return client;
  } catch (error) { client.close(); throw error; }
}

export async function getCodexModels(cwd: string) {
  const client = await createCodexClient(cwd);
  try {
    const { account } = await client.request("account/read", { refreshToken: false });
    if (!account) throw new Error("Codex CLI 尚未登录，请在本机执行 codex login");
    const models: { id: string; label: string; default: boolean; reasoningEfforts: string[] }[] = [];
    let cursor: string | null = null;
    do {
      const result: { data: { model: string; displayName: string; isDefault: boolean; hidden: boolean; supportedReasoningEfforts: { reasoningEffort: string }[] }[]; nextCursor: string | null } = await client.request("model/list", { limit: 100, cursor });
      for (const model of result.data) if (!model.hidden) models.push({
        id: model.model, label: `Codex CLI · ${model.displayName}`, default: model.isDefault,
        reasoningEfforts: model.supportedReasoningEfforts.map((item: { reasoningEffort: string }) => item.reasoningEffort),
      });
      cursor = result.nextCursor;
    } while (cursor);
    return { providerId: "codexLocal", label: "本机 Codex CLI", authenticated: true, models };
  } finally { client.close(); }
}
