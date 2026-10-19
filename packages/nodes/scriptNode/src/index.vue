<template>
  <nodeSkeleton v-bind="nodeProps" :topVisible="node.selected" :downloadUrl="downloadUrl" :downloadName="`${nodeProps.label || '剧本'}.md`" @fullscreen="openEditor(true)">
    <div class="scriptCard nodrag nopan nowheel">
      <el-alert v-if="documentState.error" :title="documentState.error" type="error" :closable="false" showIcon />
      <nav class="sectionTabs" aria-label="剧本栏目">
        <button v-for="(label, key) in scriptSectionLabels" :key="key" type="button" @click="openSection(key)">{{ label }}</button>
        <button type="button" @click="openEpisodes">分集剧本（{{ document.episodes.length }}）</button>
      </nav>
      <div v-if="previewReady" class="scriptPreview"><markdownPreview :modelValue="previewText" :files="scriptFiles" :path="path" :active="previewReady" /></div>
      <el-button :disabled="!ready" @click="openEditor(false)">编辑剧本</el-button>
    </div>
  </nodeSkeleton>
  <el-dialog v-model="editing" :title="`${nodeProps.label || '剧本'} · ${activeTitle}`" width="min(1160px, calc(100vw - 32px))" :fullscreen="fullscreen" :beforeClose="closeEditor" alignCenter appendToBody @closed="fullscreen = false">
    <div class="scriptWorkspace" :class="{ fullscreen }">
      <nav class="scriptNavigation" aria-label="剧本目录">
        <button v-for="(label, key) in scriptSectionLabels" :key="key" type="button" :class="{ active: selected === key }" :aria-current="selected === key ? 'page' : undefined" @click="selected = key">{{ label }}</button>
        <div class="episodeHeader"><span>分集剧本</span><el-button size="small" :disabled="!ready || busy" @click="addEpisode">新增</el-button></div>
        <button v-for="episode in document.episodes" :key="episode.id" type="button" :class="{ active: selected === episode.id }" :aria-current="selected === episode.id ? 'page' : undefined" @click="selected = episode.id">{{ episode.title }}</button>
      </nav>
      <div class="scriptBody">
        <div class="scriptToolbar">
          <span role="status">{{ busy ? '处理中…' : documentState.dirty ? '有未保存修改' : '已保存' }}</span>
          <el-button v-if="activeEpisode" size="small" :disabled="busy" @click="renameEpisode">分集改名</el-button>
          <el-button v-if="activeEpisode" size="small" :disabled="busy" @click="removeEpisode">删除分集</el-button>
          <el-button size="small" :disabled="busy" @click="reloadDocument">重新读取</el-button>
          <el-button type="primary" size="small" :disabled="!ready || busy || !documentState.dirty" @click="saveWithMessage">保存剧本</el-button>
        </div>
        <el-alert v-if="documentState.error" :title="documentState.error" type="error" :closable="false" showIcon />
        <markdownEditor :key="selected" v-model="activeContent" :files="scriptFiles" :path="path" :active="editing && ready" :disabled="busy || !ready" :ariaLabel="`编辑${activeTitle}`" />
      </div>
    </div>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, onMounted, onScopeDispose, ref, watch } from "vue";
import { ElAlert, ElButton, ElDialog, ElMessage, ElMessageBox } from "element-plus";
import { IconScript } from "@tabler/icons-vue";
import { nodeSkeleton, useNode, type NodeHandle, type WorkspaceFiles } from "@toonflow/nodes-scaffold/runtime";
import { useNodeDocumentState } from "@toonflow/nodes-scaffold/nodeDocument";
import markdownEditor from "@toonflow/node-shared/markdownEditor";
import markdownPreview from "@toonflow/node-shared/markdownPreview";
import { createScriptDocument, scriptDocumentSchema, scriptMarkdown, scriptMaxBytes, scriptPath, scriptSectionLabels, serializeScriptDocument, type ScriptDocument, type ScriptSection } from "./scriptDocument";

defineOptions({ inheritAttrs: false, icon: IconScript, handles: [{ id: "text", type: "source", dataType: "STRING", label: "完整剧本" }] satisfies NodeHandle[] });
const { node, nodeProps, outputs, files, nodeEvent, previewReady } = useNode({ label: "剧本", outputs: { text: { dataType: "STRING", value: "" } } });
const path = scriptPath(node.id);
const document = ref<ScriptDocument>(createScriptDocument());
const selected = ref<string>("outline");
const editing = ref(false);
const fullscreen = ref(false);
const ready = ref(false);
const busy = ref(false);
const documentState = useNodeDocumentState();
const scriptFiles = files.getWorkspaceFiles();
const data = node.data as { scriptPath?: string; scriptSnapshot?: ScriptDocument };
let snapshot: Awaited<ReturnType<WorkspaceFiles["readTextSnapshot"]>> | undefined;
let loading: Promise<void>;
let saving: Promise<void> | undefined;
let disposed = false;
const activeEpisode = computed(() => document.value.episodes.find(item => item.id === selected.value));
const activeTitle = computed(() => scriptSectionLabels[selected.value as ScriptSection] ?? activeEpisode.value?.title ?? "故事大纲");
const activeContent = computed({
  get: () => document.value.sections[selected.value as ScriptSection] ?? activeEpisode.value?.content ?? "",
  set(value: string) {
    if (!ready.value || busy.value) return;
    if (selected.value in scriptSectionLabels) document.value.sections[selected.value as ScriptSection] = value;
    else if (activeEpisode.value) activeEpisode.value.content = value;
  },
});
const previewText = computed(() => document.value.sections.outline.slice(0, 2400));
const downloadUrl = ref("");
watch(() => outputs.value.text.value, (value, _old, cleanup) => {
  const url = URL.createObjectURL(new Blob([value], { type: "text/markdown;charset=utf-8" }));
  downloadUrl.value = url;
  cleanup(() => URL.revokeObjectURL(url));
});
watch(document, () => { if (ready.value && !busy.value) documentState.dirty = true; }, { deep: true, flush: "sync" });
function errorText(error: unknown) {
  const cause = error as { response?: { data?: { message?: string; data?: { code?: string } } } };
  if (cause?.response?.data?.data?.code === "ESTALE") return "剧本已被其他设备修改。当前草稿已保留，请先复制需要保留的正文，再重新读取并合并。";
  return cause?.response?.data?.message || (error instanceof Error ? error.message : "剧本操作失败");
}
function acceptSnapshot(value: NonNullable<typeof snapshot>) {
  if (new TextEncoder().encode(value.text).length > scriptMaxBytes) throw new Error("剧本文档不能超过 10MB");
  const parsed = scriptDocumentSchema.parse(JSON.parse(value.text));
  if (disposed) return;
  snapshot = value;
  document.value = parsed;
  outputs.value.text.value = scriptMarkdown(parsed);
  data.scriptPath = path;
  delete data.scriptSnapshot;
  if (!Object.hasOwn(outputs.value, "toJSON")) Object.defineProperty(outputs.value, "toJSON", { value: () => ({}) });
  if (!(selected.value in scriptSectionLabels) && !parsed.episodes.some(item => item.id === selected.value)) selected.value = "outline";
  documentState.dirty = false;
  documentState.error = "";
  ready.value = true;
}
async function loadDocument(initialize = false) {
  busy.value = true;
  try {
    if (data.scriptPath !== undefined && data.scriptPath !== path) throw new Error("剧本文件路径无效");
    if (initialize && !data.scriptPath) {
      for (const directory of ["assets", `assets/${node.id}`]) await scriptFiles.mkdir(directory).catch(error => {
        if (error.response?.data?.data?.code !== "EEXIST") throw error;
      });
      await scriptFiles.write(path, serializeScriptDocument(data.scriptSnapshot ?? createScriptDocument()), true).catch(error => {
        if (error.response?.data?.data?.code !== "EEXIST") throw error;
        if (data.scriptSnapshot) throw new Error("复制目标已存在剧本文档，请保留草稿并检查节点 ID");
      });
    }
    acceptSnapshot(await scriptFiles.readTextSnapshot(path));
  } catch (error) { documentState.error = errorText(error); }
  finally { busy.value = false; }
}
async function saveDocument() {
  if (saving) return saving;
  if (!ready.value || !snapshot) throw new Error("剧本尚未加载");
  if (!documentState.dirty) {
    if (documentState.error) throw new Error(documentState.error);
    return;
  }
  const text = serializeScriptDocument(document.value);
  busy.value = true;
  saving = (async () => {
    try {
      const revision = await scriptFiles.writeTextSnapshot(path, text, snapshot!);
      acceptSnapshot({ ...snapshot!, revision, text });
    } catch (error) { documentState.error = errorText(error); throw new Error(documentState.error); }
    finally { busy.value = false; saving = undefined; }
  })();
  return saving;
}
async function saveWithMessage() {
  try { await saveDocument(); ElMessage.success("剧本已保存"); }
  catch (error) { ElMessage.error(errorText(error)); }
}
function openEditor(expand: boolean) { fullscreen.value = expand; editing.value = true; }
function openSection(section: ScriptSection) { selected.value = section; openEditor(false); }
function openEpisodes() { selected.value = document.value.episodes[0]?.id ?? "outline"; openEditor(false); }
async function closeEditor(done: () => void) {
  if (!documentState.dirty && !busy.value) return done();
  try { await saveDocument(); done(); }
  catch (error) { ElMessage.error(errorText(error)); }
}
async function reloadDocument() {
  if (busy.value) return;
  if (documentState.dirty) {
    const confirmed = await ElMessageBox.confirm("重新读取会放弃当前未保存草稿，请先复制需要保留的正文。", "重新读取剧本", { type: "warning", confirmButtonText: "放弃草稿并读取", cancelButtonText: "取消" }).then(() => true, () => false);
    if (!confirmed) return;
  }
  await loadDocument();
}
async function episodeTitle(value = "") {
  return ElMessageBox.prompt("分集标题", "分集剧本", { inputValue: value, inputValidator: input => !!input?.trim() && input.trim().length <= 160 || "请输入 1–160 字的标题", confirmButtonText: "确定", cancelButtonText: "取消" }).then(result => result.value.trim(), () => undefined);
}
async function addEpisode() {
  const title = await episodeTitle();
  if (!title || busy.value) return;
  if (document.value.episodes.length >= 1000) return void ElMessage.error("最多支持 1000 集");
  const id = crypto.randomUUID();
  document.value.episodes.push({ id, title, content: "" });
  selected.value = id;
}
async function renameEpisode() {
  const episode = activeEpisode.value;
  if (!episode) return;
  const title = await episodeTitle(episode.title);
  if (title && !busy.value) episode.title = title;
}
async function removeEpisode() {
  const episode = activeEpisode.value;
  if (!episode) return;
  const confirmed = await ElMessageBox.confirm(`删除「${episode.title}」及其正文？保存后生效。`, "删除分集", { type: "warning", confirmButtonText: "删除", cancelButtonText: "取消" }).then(() => true, () => false);
  if (!confirmed || busy.value) return;
  document.value.episodes = document.value.episodes.filter(item => item.id !== episode.id);
  selected.value = "outline";
}
nodeEvent.on("save", async () => { await loading; await saveDocument(); });
nodeEvent.on("copy", () => {
  if (!ready.value) throw new Error("剧本尚未加载，无法复制");
  return { scriptPath: undefined, scriptSnapshot: scriptDocumentSchema.parse(document.value) };
});
onMounted(() => { loading = loadDocument(true); });
// ACT: 可见且无草稿时每 5 秒读取一次，MCP 修改不依赖画布广播；有草稿时由版本校验保护。
const refreshTimer = setInterval(async () => {
  if (disposed || !ready.value || busy.value || documentState.dirty || !(previewReady.value || editing.value || node.selected)) return;
  try {
    const next = await scriptFiles.readTextSnapshot(path);
    if (disposed || busy.value || documentState.dirty) return;
    if (next.revision !== snapshot?.revision) {
      busy.value = true;
      try { acceptSnapshot(next); }
      finally { busy.value = false; }
    }
    else documentState.error = "";
  } catch (error) { documentState.error = errorText(error); }
}, 5000);
onScopeDispose(() => { disposed = true; clearInterval(refreshTimer); });
</script>

<style lang="scss" scoped>
.scriptCard {
  min-width: 420px; max-width: 620px;
  .sectionTabs { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px;
    button { border: 1px solid var(--el-border-color); border-radius: 6px; padding: 6px 10px; cursor: pointer; background: var(--el-fill-color-light); color: var(--el-text-color-primary); }
  }
  .scriptPreview { max-height: 220px; overflow: auto; margin-bottom: 12px; }
}
.scriptWorkspace {
  display: flex; height: min(680px, calc(100dvh - 200px)); min-height: 280px; gap: 20px;
  &.fullscreen { height: calc(100dvh - 110px); }
  .scriptNavigation { flex: 0 0 180px; overflow: auto; border-right: 1px solid var(--el-border-color); padding-right: 12px;
    button { display: block; width: 100%; text-align: left; overflow-wrap: anywhere; padding: 10px; margin-bottom: 4px; border: 0; border-radius: 6px; background: transparent; color: var(--el-text-color-primary); cursor: pointer;
      &.active { color: var(--el-color-primary); background: var(--el-color-primary-light-9); }
    }
    .episodeHeader { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 20px 0 8px; font-weight: 600;
      :deep(button) { width: auto; margin: 0; padding: 6px; }
    }
  }
  .scriptBody { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 12px;
    .scriptToolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
      span { margin-right: auto; font-size: 12px; color: var(--el-text-color-secondary); }
      :deep(button) { margin: 0; }
    }
  }
}
@media (max-width: 700px) { .scriptWorkspace { flex-direction: column; .scriptNavigation { flex: 0 0 120px; border-right: 0; border-bottom: 1px solid var(--el-border-color); } } }
</style>
