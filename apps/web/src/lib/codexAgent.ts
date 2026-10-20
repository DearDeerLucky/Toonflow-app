import { computed, shallowRef } from "vue";
import axios from "axios";
import { modelChoices } from "@/stores/settings";

type CodexModel = { id: string; label: string; default: boolean; reasoningEfforts: string[] };
export const codexModels = shallowRef<CodexModel[]>([]);
export const codexProviders = computed(() => codexModels.value.length ? [{ id: "codexLocal", label: "本机 Codex CLI", models: codexModels.value }] : []);
export const agentModelChoices = computed(() => [...modelChoices.value, ...codexModels.value.map(model => ({
  value: JSON.stringify(["codexLocal", model.id]), providerId: "codexLocal", modelId: model.id, label: model.label, contextWindow: undefined,
}))]);

export async function loadCodexModels(directory: string) {
  const { data } = await axios.get("/api/agent/codex", { params: { directory }, headers: { "x-toonflow-workspace": "1" } });
  if (data.code !== 200) throw new Error(data.message || "读取本机 Codex 模型失败");
  codexModels.value = data.data.models;
}
