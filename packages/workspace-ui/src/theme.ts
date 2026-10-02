/**
 * Light or dark, for every surface both products draw: the page's colour
 * tokens, the editor, and the terminal.
 *
 * "system" follows the OS and is the default. A choice of light or dark is an
 * attribute on <html>, which theme.css reads, so the stylesheet decides the
 * colours and nothing here holds a palette of its own except the editor's.
 */

export type ThemeChoice = "system" | "light" | "dark";

export const THEME_CHOICES: readonly ThemeChoice[] = ["system", "light", "dark"];

const CHANGED = "ajar-theme";
const prefersDark = () => matchMedia("(prefers-color-scheme: dark)");

export function parseTheme(raw: string | null): ThemeChoice {
  return raw === "light" || raw === "dark" ? raw : "system";
}

export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === "system") delete root.dataset.theme;
  else root.dataset.theme = choice;
  root.dispatchEvent(new Event(CHANGED));
}

/**
 * The stored choice, applied before anything renders.
 *
 * Called first thing in each product's entry module. Not an inline script in
 * the page head: both sites' CSPs refuse inline scripts. The key is the one
 * the workspace shell writes.
 */
export function applyStoredTheme(prefix: string): void {
  let raw: string | null = null;
  try { raw = localStorage.getItem(`${prefix}.theme`); } catch { /* Follows the system. */ }
  applyTheme(parseTheme(raw));
}

export function themeChoice(): ThemeChoice {
  return parseTheme(document.documentElement.dataset.theme ?? null);
}

export function isDark(): boolean {
  const choice = themeChoice();
  return choice === "system" ? prefersDark().matches : choice === "dark";
}

/** Calls back whenever the page turns light or dark, from a choice or from the OS. */
export function onThemeChange(callback: (dark: boolean) => void, signal: AbortSignal): void {
  document.documentElement.addEventListener(CHANGED, () => callback(isDark()), { signal });
  prefersDark().addEventListener("change", () => {
    if (themeChoice() === "system") callback(isDark());
  }, { signal });
}

// ---------------------------------------------------------------- editor

/** The part of Monaco's editor namespace this needs; either product's version fits. */
export interface EditorThemes {
  defineTheme(name: string, data: {
    base: "vs" | "vs-dark";
    inherit: boolean;
    rules: { token: string; foreground?: string }[];
    colors: Record<string, string>;
  }): void;
}

/**
 * One colour per CSV column, cycling after eight. Picked to read on Monaco's
 * own light and dark backgrounds, and to stay apart from each other.
 */
const COLUMNS = {
  light: ["1f5fbf", "a3461b", "1d7a46", "8a3fa8", "b0124e", "0f7a85", "7a6400", "555f6d"],
  dark: ["79b8ff", "f0a35e", "7ed69b", "d2a8ff", "ff8fa8", "6fd6d6", "e3cc6b", "b4bcc8"],
};

/** Monaco's own light and dark themes, plus colours for the tokens only these products emit. */
export function defineEditorThemes(editor: EditorThemes): void {
  for (const [name, base, columns, delimiter] of [
    ["ajar-light", "vs", COLUMNS.light, "8a94a2"],
    ["ajar-dark", "vs-dark", COLUMNS.dark, "6c7684"],
  ] as const) {
    editor.defineTheme(name, {
      base,
      inherit: true,
      rules: [
        ...columns.map((foreground, i) => ({ token: `column${i}`, foreground })),
        { token: "delimiter.csv", foreground: delimiter },
        { token: "delimiter.tsv", foreground: delimiter },
      ],
      colors: {},
    });
  }
}

export function editorTheme(): string {
  return isDark() ? "ajar-dark" : "ajar-light";
}
