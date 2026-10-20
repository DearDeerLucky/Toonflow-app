import { isEqual } from "lodash-es";
import type { Node, Edge, ViewportTransform } from "@vue-flow/core";
import type { TextSnapshot } from "@/lib/workspaceFiles";

export type CanvasFile = { toonflowCanvas: true; nodes: Node[]; edges: Edge[]; viewport: ViewportTransform };

export function parseCanvasSnapshot(snapshot: TextSnapshot): CanvasFile {
  const data = JSON.parse(snapshot.text) as CanvasFile;
  if (data?.toonflowCanvas !== true || !Array.isArray(data.nodes) || !Array.isArray(data.edges) || !data.viewport
    || ![data.viewport.x, data.viewport.y, data.viewport.zoom].every(Number.isFinite) || data.viewport.zoom <= 0
    || [...data.nodes, ...data.edges].some(item => !item || typeof item.id !== "string" || !item.id)) throw new Error("画布文件格式无效");
  const nodes = new Set(data.nodes.map(node => node.id));
  if (nodes.size !== data.nodes.length || new Set(data.edges.map(edge => edge.id)).size !== data.edges.length
    || data.edges.some(edge => !nodes.has(edge.source) || !nodes.has(edge.target))) throw new Error("画布节点或连线无效");
  return data;
}

function mergeValue(base: unknown, local: unknown, remote: unknown): unknown {
  if (isEqual(local, base)) return remote;
  if (isEqual(remote, base) || isEqual(local, remote)) return local;
  const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
  if (object(base) && object(local) && object(remote)) {
    return Object.fromEntries([...new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)])]
      .map(key => [key, mergeValue(base[key], local[key], remote[key])]).filter(([, value]) => value !== undefined));
  }
  throw new Error("同一节点内容已被其他端修改，已停止覆盖。请先保存本地副本，再载入远端版本。");
}

export function mergeCanvas(base: CanvasFile, local: CanvasFile, remote: CanvasFile): CanvasFile {
  function mergeElements<T extends { id: string }>(base: T[], local: T[], remote: T[]): T[] {
    const before = new Map(base.map(item => [item.id, item]));
    const ours = new Map(local.map(item => [item.id, item]));
    const theirs = new Map(remote.map(item => [item.id, item]));
    return [...new Set([...remote.map(item => item.id), ...local.map(item => item.id)])]
      .flatMap(id => {
        const merged = mergeValue(before.get(id), ours.get(id), theirs.get(id));
        return merged === undefined ? [] : [merged as T];
      });
  }
  const nodes = mergeElements(base.nodes, local.nodes, remote.nodes);
  const edges = mergeElements(base.edges, local.edges, remote.edges);
  const ids = new Set(nodes.map(node => node.id));
  if (edges.some(edge => !ids.has(edge.source) || !ids.has(edge.target))
    || nodes.some(node => node.parentNode && !ids.has(node.parentNode))) throw new Error("节点删除与连线或分组修改冲突，已停止覆盖。请保存本地副本后载入远端版本。");
  // ACT: 同步节点与连线，视角始终由当前浏览器控制，避免另一端缩放导致画布跳动。
  return { toonflowCanvas: true, nodes, edges, viewport: local.viewport };
}

export function canvasPreferenceKey(directory: string) {
  const path = directory.replaceAll("\\", "/").replace(/\/$/, "");
  return `toonflow.lastCanvas:${/^(?:[a-z]:\/|\/\/)/i.test(path) ? path.toLowerCase() : path}`;
}
