/** Platform-specific labels and exact shortcut matching, also used by browser checks. */
export const isApple = (platform: string) => /Mac|iPhone|iPad|iPod/i.test(platform);
export function shortcutLabel(mode: "names" | "contents", apple: boolean): string {
  return apple ? mode === "names" ? "⌘P" : "⌘⇧F" : mode === "names" ? "Ctrl+P" : "Ctrl+Shift+F";
}
export function searchShortcut(event: KeyboardEvent, apple: boolean): "names" | "contents" | null {
  if (event.isComposing || event.keyCode === 229 || event.repeat || event.altKey || event.getModifierState("AltGraph")) return null;
  if (apple ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey) return null;
  // Logical letters cover remapped layouts; physical keys cover layouts without Latin letters.
  const key = event.key.toLowerCase();
  if (!event.shiftKey && (key === "p" || event.code === "KeyP")) return "names";
  if (event.shiftKey && (key === "f" || event.code === "KeyF")) return "contents";
  return null;
}
