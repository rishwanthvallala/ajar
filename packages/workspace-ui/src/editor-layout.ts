/** Serializable editor layout. Files and document contents belong to the product. */
export type EditorNode = EditorGroup | EditorSplit;
export interface EditorGroup { kind: "group"; id: string; tabs: string[]; active: string | null }
export interface EditorSplit { kind: "split"; id: string; direction: "right" | "down"; ratio: number; first: EditorNode; second: EditorNode }
export interface EditorLayout { version: 1; root: EditorNode; focused: string }

let sequence = 0;
const id = () => `editor-${Date.now().toString(36)}-${++sequence}`;
export function newGroup(): EditorGroup { return { kind: "group", id: id(), tabs: [], active: null }; }
export function groups(node: EditorNode): EditorGroup[] { return node.kind === "group" ? [node] : [...groups(node.first), ...groups(node.second)]; }
export function initialLayout(): EditorLayout { const root = newGroup(); return { version: 1, root, focused: root.id }; }

/** Treat preferences as untrusted, bounded input; never restore file contents. */
export function readLayout(raw: string | null): EditorLayout | null {
  try {
    const value = JSON.parse(raw ?? "null");
    if (value?.version !== 1) return null;
    const ids = new Set<string>();
    let count = 0;
    const node = (v: any, depth = 0): EditorNode => {
      if (++count > 255 || depth > 32 || !v || typeof v.id !== "string" || ids.has(v.id)) throw Error("Invalid layout");
      ids.add(v.id);
      if (v.kind === "group" && Array.isArray(v.tabs) && v.tabs.length <= 2000) {
        const tabs = [...new Set<string>(v.tabs.filter((p: unknown): p is string => typeof p === "string" && p.length > 0 && p.length < 4096))];
        return { kind: "group", id: v.id, tabs, active: tabs.includes(v.active) ? v.active : tabs[0] ?? null };
      }
      if (v.kind !== "split" || !["right", "down"].includes(v.direction) || !Number.isFinite(v.ratio)) throw Error("Invalid split");
      return { kind: "split", id: v.id, direction: v.direction, ratio: Math.max(.1, Math.min(.9, v.ratio)), first: node(v.first, depth + 1), second: node(v.second, depth + 1) };
    };
    const root = node(value.root);
    return { version: 1, root, focused: groups(root).some(g => g.id === value.focused) ? value.focused : groups(root)[0]!.id };
  } catch { return null; }
}

export class EditorLayoutModel {
  state: EditorLayout;
  constructor(state = initialLayout()) { this.state = state; }
  get groups() { return groups(this.state.root); }
  get current() { return this.groups.find(g => g.id === this.state.focused)!; }
  group(id: string) { return this.groups.find(g => g.id === id); }
  focus(id: string) { if (this.group(id)) this.state.focused = id; }
  open(path: string, group = this.current.id, index?: number) {
    const target = this.group(group);
    if (!target || !path) return;
    if (!target.tabs.includes(path)) target.tabs.splice(index ?? target.tabs.length, 0, path);
    target.active = path; this.focus(group);
  }
  close(path: string, group = this.current.id) {
    const target = this.group(group);
    if (!target) return;
    const index = target.tabs.indexOf(path);
    if (index < 0) return;
    target.tabs.splice(index, 1);
    if (target.active === path) target.active = target.tabs[index] ?? target.tabs[index - 1] ?? null;
    if (!target.tabs.length && this.groups.length > 1) {
      this.removeGroup(group);
    }
  }
  removeGroup(group = this.current.id) {
    const before = this.groups, target = this.group(group);
    if (!target) return;
    if (before.length === 1) { target.tabs = []; target.active = null; return; }
    const at = before.indexOf(target);
    const remove = (n: EditorNode): EditorNode | null => {
      if (n.kind === "group") return n.id === group ? null : n;
      const first = remove(n.first), second = remove(n.second);
      return first && second ? { ...n, first, second } : first ?? second;
    };
    this.state.root = remove(this.state.root)!;
    if (this.state.focused === group) this.state.focused = (before[at + 1] ?? before[at - 1])!.id;
  }
  split(direction: "right" | "down", group = this.current.id, path = this.group(group)?.active): EditorGroup | null {
    const target = this.group(group);
    if (!target) return null;
    const created = newGroup();
    if (path) { created.tabs = [path]; created.active = path; }
    const replace = (n: EditorNode): EditorNode => n.id === group
      ? { kind: "split", id: id(), direction, ratio: .5, first: n, second: created }
      : n.kind === "split" ? { ...n, first: replace(n.first), second: replace(n.second) } : n;
    this.state.root = replace(this.state.root); this.focus(created.id);
    return created;
  }
  move(path: string, from: string, to: string, index?: number) {
    const source = this.group(from), target = this.group(to);
    if (!source?.tabs.includes(path) || !target) return;
    if (source === target) {
      const at = source.tabs.indexOf(path);
      source.tabs.splice(at, 1);
      source.tabs.splice(index === undefined ? source.tabs.length : index > at ? index - 1 : index, 0, path);
      source.active = path; this.focus(to);
    } else { this.open(path, to, index); this.close(path, from); }
  }
  rename(from: string, to: string) {
    for (const group of this.groups) {
      group.tabs = [...new Set(group.tabs.map(p => p === from ? to : p))];
      if (group.active === from) group.active = to;
    }
  }
  prune(exists: (path: string) => boolean) {
    for (const group of [...this.groups]) for (const path of [...group.tabs]) if (!exists(path)) this.close(path, group.id);
  }
}
