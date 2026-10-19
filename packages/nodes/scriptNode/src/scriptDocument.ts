import { z } from "zod";

export const scriptSectionLabels = { outline: "故事大纲", characters: "人物小传", scenes: "场景设计", props: "道具设计" } as const;
export type ScriptSection = keyof typeof scriptSectionLabels;
export const scriptMaxBytes = 10 * 1024 * 1024;
const contentSchema = z.string().max(1_000_000);
const episodeSchema = z.strictObject({ id: z.uuid(), title: z.string().trim().min(1).max(160), content: contentSchema });
export const scriptDocumentSchema = z.strictObject({
  toonflowScript: z.literal(1),
  sections: z.strictObject({ outline: contentSchema, characters: contentSchema, scenes: contentSchema, props: contentSchema }),
  episodes: z.array(episodeSchema).max(1000).refine(items => new Set(items.map(item => item.id)).size === items.length, "分集 ID 不能重复"),
});
export type ScriptDocument = z.infer<typeof scriptDocumentSchema>;
export const scriptNodeIdSchema = z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/, "节点 ID 只能包含字母、数字、下划线和短横线");
const revisionSchema = z.string().regex(/^[a-f0-9]{64}$/, "写入必须提供读取时的 revision");
export const scriptActionSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("read") }),
  z.strictObject({ action: z.literal("create") }),
  z.strictObject({ action: z.literal("writeSection"), expectedRevision: revisionSchema, section: z.enum(["outline", "characters", "scenes", "props", "episode"]), episodeId: z.uuid().optional(), content: contentSchema }),
  z.strictObject({ action: z.literal("addEpisode"), expectedRevision: revisionSchema, title: episodeSchema.shape.title, content: contentSchema.default("") }),
  z.strictObject({ action: z.literal("renameEpisode"), expectedRevision: revisionSchema, episodeId: z.uuid(), title: episodeSchema.shape.title }),
  z.strictObject({ action: z.literal("removeEpisode"), expectedRevision: revisionSchema, episodeId: z.uuid() }),
]);
export type ScriptAction = z.infer<typeof scriptActionSchema>;
export const scriptRequestSchema = z.strictObject({ nodeId: scriptNodeIdSchema, operation: scriptActionSchema });

export function scriptPath(nodeId: string) {
  return `assets/${scriptNodeIdSchema.parse(nodeId)}/script.json`;
}
export function createScriptDocument(): ScriptDocument {
  return { toonflowScript: 1, sections: { outline: "", characters: "", scenes: "", props: "" }, episodes: [] };
}
export function serializeScriptDocument(value: unknown) {
  const text = JSON.stringify(scriptDocumentSchema.parse(value), null, 2) + "\n";
  if (new TextEncoder().encode(text).length > scriptMaxBytes) throw new Error("剧本文档不能超过 10MB");
  return text;
}
export function scriptMarkdown(document: ScriptDocument) {
  return [...Object.entries(scriptSectionLabels).map(([key, label]) => `# ${label}\n\n${document.sections[key as ScriptSection]}`),
    ...document.episodes.map(episode => `# ${episode.title}\n\n${episode.content}`)].join("\n\n");
}
export function applyScriptAction(document: ScriptDocument, action: ScriptAction): ScriptDocument {
  const next = structuredClone(document);
  if (action.action === "writeSection" && action.section !== "episode") next.sections[action.section] = action.content;
  else if (action.action === "addEpisode") next.episodes.push({ id: crypto.randomUUID(), title: action.title, content: action.content });
  else if (["writeSection", "renameEpisode", "removeEpisode"].includes(action.action)) {
    const id = "episodeId" in action ? action.episodeId : undefined;
    const episode = next.episodes.find(item => item.id === id);
    if (!episode) throw new Error("分集不存在，请重新读取剧本");
    if (action.action === "writeSection") episode.content = action.content;
    else if (action.action === "renameEpisode") episode.title = action.title;
    else next.episodes = next.episodes.filter(item => item.id !== id);
  } else throw new Error("此操作不能修改现有剧本");
  return scriptDocumentSchema.parse(next);
}
