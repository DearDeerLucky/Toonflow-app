import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { mkdir, readFile, stat } from "@toonflow/file";
import { applyScriptAction, createScriptDocument, scriptDocumentSchema, scriptMaxBytes, scriptPath, serializeScriptDocument, type ScriptAction } from "@toonflow/node-script/document";
import { lockWorkspaceFiles, resolveWorkspacePath, writeWorkspaceFile } from "@/utils/workspace/files";

export async function scriptDocuments(directory: string, nodeId: string, operation: ScriptAction, signal: AbortSignal) {
  const path = scriptPath(nodeId);
  const source = await resolveWorkspacePath(directory, path, operation.action === "create");
  const release = lockWorkspaceFiles([source.path]);
  try {
    signal.throwIfAborted();
    if (operation.action === "create") {
      await mkdir(dirname(source.path), { recursive: true });
      await writeWorkspaceFile(source.path, serializeScriptDocument(createScriptDocument()), true);
    }
    const info = await stat(source.path);
    if (!info.isFile() || info.size > scriptMaxBytes) throw new Error("剧本必须是不超过 10MB 的普通文件");
    let bytes = await readFile(source.path, { signal });
    if (bytes.length > scriptMaxBytes) throw new Error("剧本文档不能超过 10MB");
    const revision = createHash("sha256").update(bytes).digest("hex");
    let document = scriptDocumentSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    if (operation.action !== "read" && operation.action !== "create") {
      if (revision !== operation.expectedRevision) throw Object.assign(new Error("剧本已被其他设备修改，请重新读取并合并内容后再保存"), { code: "ESTALE", status: 409 });
      document = applyScriptAction(document, operation);
      bytes = Buffer.from(serializeScriptDocument(document));
      signal.throwIfAborted();
      await writeWorkspaceFile(source.path, bytes);
    }
    return { nodeId, path, revision: createHash("sha256").update(bytes).digest("hex"), document };
  } finally { release(); }
}
