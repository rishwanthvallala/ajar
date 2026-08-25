/**
 * Sizes that follow the reader, not the stylesheet author.
 *
 * Page zoom scales CSS pixels on its own, so most of the interface needs
 * nothing. What it does not cover is a reader who has raised their default
 * font size: rem-based chrome grows, and anything handed a raw number stays
 * put. xterm and Monaco both want a number.
 *
 * Its own module rather than living in `main.ts`: the viewer is loaded lazily,
 * and importing the entry point from it would pull the whole application into
 * that chunk and make a cycle out of it.
 */

function rootFontPx(): number {
  return parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
}

/** Resolve a CSS custom property to pixels. */
export function cssPx(name: string, fallback: number): number {
  const declared = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  if (!declared) return fallback;
  if (declared.endsWith("rem")) return Math.round(parseFloat(declared) * rootFontPx());
  return parseFloat(declared) || fallback;
}

/** Terminal and editor text size, in pixels. */
export function codeFontPx(): number {
  return cssPx("--code-size", 13);
}
