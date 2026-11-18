/**
 * Image files, which the pad shows rather than only offering to download:
 * a plot `plt.show()` saved (tools/sitecustomize.py), a picture a program
 * made, one uploaded. SVG is not here: it is text, and opens in the editor.
 */
const TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
};

/** The image type of a file, by its name, or null when it is not one the pad shows. */
export function imageType(path: string): string | null {
  return TYPES[path.split(".").pop()?.toLowerCase() ?? ""] ?? null;
}

/**
 * The escape a program prints to have the pad show an image:
 * `ESC ] 7777 ; pad-image=<absolute path> BEL`. A number no terminal
 * standard uses, so nothing else means it.
 */
export const IMAGE_OSC = 7777;

/** The folder path an escape names, or null for one outside the folder, which the pad cannot read. */
export function imageFromOsc(data: string, root: string): string | null {
  const match = /^pad-image=(.+)$/.exec(data);
  if (!match) return null;
  const path = match[1]!;
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : null;
}
