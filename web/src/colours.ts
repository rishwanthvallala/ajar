import { isDark } from "@ajar/workspace-ui/theme";

// Each person's colour: their cursor in the editor and their dot among the
// people here, so the two can be matched at a glance. In a module of its own
// because the page needs it before — and without — the editor.

const COLOURS = [
  "#2447c9",
  "#9e5a15",
  "#1c6a4b",
  "#a63a2a",
  "#5b3fa8",
  "#0f6b63",
  "#8a5a0b",
  "#7a2f5f",
];

/**
 * The same eight, lightened for a dark editor: the light set measured 1.9 to
 * 3.1 to 1 against it, and a cursor you cannot find is no cursor.
 */
const DARK_COLOURS = [
  "#8ca6ff",
  "#e0a35a",
  "#55bc8d",
  "#ef8a76",
  "#b49cff",
  "#4fc1b6",
  "#dcb04e",
  "#e382b6",
];

export function colourFor(id: number): string {
  const palette = isDark() ? DARK_COLOURS : COLOURS;
  return palette[id % palette.length];
}

