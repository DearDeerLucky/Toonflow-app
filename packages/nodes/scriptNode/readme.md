# 剧本节点

在画布添加「剧本」，点击栏目或「编辑剧本」打开编辑器。四个固定栏目为故事大纲、人物小传、场景设计、道具设计；分集剧本支持新增、改名和删除。正文支持 Markdown 富文本和原文模式。点击「保存剧本」或关闭编辑器时保存，也参与画布的保存流程。

正文存于工作区 `assets/<nodeId>/script.json`，画布仅保存路径；复制节点会生成独立文档。完整剧本以文本输出，可连接后续节点、作为 Agent 引用或下载 Markdown。删除节点沿用宿主的素材保留规则，支持撤销。

无未保存修改的可见节点每 5 秒读取磁盘，显示其他设备通过 MCP 保存的更新。有草稿时不覆盖；保存遇到版本冲突会保留草稿。请先复制需要保留的正文，再「重新读取」并合并。一个节点的版本覆盖整本剧本，不按栏目单独加锁。

## MCP

调用 `scriptDocuments`，显式指定 `target.directory` 后，无需服务器打开页面：

```json
{
  "target": { "directory": "E:\\MiniMovie\\projects\\pilot" },
  "args": { "nodeId": "画布中实际的节点ID", "operation": { "action": "read" } }
}
```

返回 `nodeId`、相对 `path`、SHA256 `revision` 和 `document`。修改须携带最近读取的版本：

```json
{
  "target": { "directory": "E:\\MiniMovie\\projects\\pilot" },
  "args": {
    "nodeId": "画布中实际的节点ID",
    "operation": {
      "action": "writeSection",
      "expectedRevision": "上次返回的64位revision",
      "section": "outline",
      "content": "# 故事大纲\n\n正文"
    }
  }
}
```

`operation` 操作：

| action | 其他参数 |
| --- | --- |
| read | 无 |
| create | 无；仅新建空文档，不创建画布节点，已存在时报错 |
| writeSection | expectedRevision、section（outline/characters/scenes/props/episode）、content；episode 还需 episodeId |
| addEpisode | expectedRevision、title、可选 content；返回文档包含新的分集 ID |
| renameEpisode | expectedRevision、episodeId、title |
| removeEpisode | expectedRevision、episodeId |

每次修改后使用返回的新 `revision`。发生冲突必须重新读取并合并，不得只换 revision 强制重试。新建画布节点仍通过现有画布 MCP 工具，节点类型为 `remote-scriptNode`；专用工具只管理文档，不能创建或移动画布节点。每个栏目/分集最多 100 万字符，最多 1000 集，整个文档不超过 10MB。MCP 遵循现有工作区访问范围和只读设置。
