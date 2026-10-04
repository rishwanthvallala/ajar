/**
 * Icons for the account pages and dialogs: inline SVG, because the pad's CSP
 * allows images only from this origin and `data:`, and inline markup follows
 * `currentColor` — so one icon works on every surface and in both themes.
 *
 * Stroke icons are drawn on a 16-unit grid at 1.4, like the shell's own.
 */

const stroke = (d: string) =>
  `<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;

export const ICONS = {
  // The two providers' own marks, as their sign-in guidelines ask for.
  google: `<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.1H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 8 3l5.7-5.7C34 6.1 29.3 4 24 4 13 4 4 13 4 24s9 20 20 20 20-9 20-20c0-1.3-.1-2.6-.4-3.9z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 8 3l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2A11.9 11.9 0 0 1 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.1H42V20H24v8h11.3a12 12 0 0 1-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.6-.4-3.9z"/></svg>`,
  github: `<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>`,

  globe: stroke(`<circle cx="8" cy="8" r="6.2"/><path d="M1.8 8h12.4M8 1.8c1.7 1.8 2.5 3.9 2.5 6.2S9.7 12.4 8 14.2C6.3 12.4 5.5 10.3 5.5 8S6.3 3.6 8 1.8Z"/>`),
  link: stroke(`<path d="M6.6 9.4a2.6 2.6 0 0 0 3.7 0l2.3-2.3a2.6 2.6 0 0 0-3.7-3.7l-.9.9"/><path d="M9.4 6.6a2.6 2.6 0 0 0-3.7 0L3.4 8.9a2.6 2.6 0 0 0 3.7 3.7l.9-.9"/>`),
  lock: stroke(`<rect x="3.2" y="7" width="9.6" height="7" rx="1.6"/><path d="M5.3 7V5.1a2.7 2.7 0 0 1 5.4 0V7"/>`),
  pencil: stroke(`<path d="M10.6 2.9a1.6 1.6 0 0 1 2.3 2.3L5.6 12.5l-3 .8.8-3 7.2-7.4Z"/><path d="m9.4 4.1 2.3 2.3"/>`),
  eye: stroke(`<path d="M1.6 8s2.3-4.6 6.4-4.6S14.4 8 14.4 8s-2.3 4.6-6.4 4.6S1.6 8 1.6 8Z"/><circle cx="8" cy="8" r="2"/>`),
  copy: stroke(`<rect x="5.4" y="5.4" width="8" height="8" rx="1.5"/><path d="M10.6 5.4V3.9a1.3 1.3 0 0 0-1.3-1.3H3.9a1.3 1.3 0 0 0-1.3 1.3v5.4a1.3 1.3 0 0 0 1.3 1.3h1.5"/>`),
  check: stroke(`<path d="m3.2 8.4 3 3 6.6-6.8"/>`),
  plus: stroke(`<path d="M8 3v10M3 8h10"/>`),
  trash: stroke(`<path d="M2.6 4.2h10.8M6.3 4.2V2.8h3.4v1.4M4 4.2l.6 8.8a1.3 1.3 0 0 0 1.3 1.2h4.2a1.3 1.3 0 0 0 1.3-1.2l.6-8.8M6.6 6.8v4.6M9.4 6.8v4.6"/>`),
  open: stroke(`<path d="M9.5 2.6h3.9v3.9M13.2 2.8 7.4 8.6"/><path d="M11.6 9.4v3a1.2 1.2 0 0 1-1.2 1.2H3.8a1.2 1.2 0 0 1-1.2-1.2V5.8a1.2 1.2 0 0 1 1.2-1.2h3"/>`),
  chevron: stroke(`<path d="m4.5 6.2 3.5 3.6 3.5-3.6"/>`),
  close: stroke(`<path d="m4 4 8 8M12 4l-8 8"/>`),
  out: stroke(`<path d="M6.2 13.4H3.8a1.2 1.2 0 0 1-1.2-1.2V3.8a1.2 1.2 0 0 1 1.2-1.2h2.4M10.4 11.2 13.6 8l-3.2-3.2M13.4 8H6"/>`),
  reset: stroke(`<path d="M2.8 8a5.2 5.2 0 1 0 1.6-3.8"/><path d="M2.6 2.6v2.8h2.8"/>`),
  alert: stroke(`<circle cx="8" cy="8" r="6.2"/><path d="M8 4.8v3.6M8 11h.01"/>`),
  arrow: stroke(`<path d="M3 8h10M9 4l4 4-4 4"/>`),
  file: stroke(`<path d="M9.2 1.8H4.4a1.3 1.3 0 0 0-1.3 1.3v9.8a1.3 1.3 0 0 0 1.3 1.3h7.2a1.3 1.3 0 0 0 1.3-1.3V5.5L9.2 1.8Z"/><path d="M9 1.9v3.8h3.8M5.8 9.2l-1.3 1.3 1.3 1.3M10.2 9.2l1.3 1.3-1.3 1.3"/>`),
  pads: stroke(`<rect x="2.2" y="2.2" width="5" height="5" rx="1.2"/><rect x="8.8" y="2.2" width="5" height="5" rx="1.2"/><rect x="2.2" y="8.8" width="5" height="5" rx="1.2"/><rect x="8.8" y="8.8" width="5" height="5" rx="1.2"/>`),
  // The same three the shell's theme button cycles through.
  system: `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M8 2.5a5.5 5.5 0 0 1 0 11Z" fill="currentColor"/></svg>`,
  light: `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="2.75" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M8 1.5V3M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`,
  dark: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13 9.6A5.5 5.5 0 1 1 6.4 3a4.4 4.4 0 0 0 6.6 6.6Z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>`,
  // pad's mark: a page of code, three lines indented. Colours come from CSS so
  // it inverts with the theme.
  mark: `<svg viewBox="0 0 24 24" aria-hidden="true" class="mark"><rect class="mark-bg" width="24" height="24" rx="6.5"/><path class="mark-lines" d="M6.5 8h8.5M9 12h8.5M9 16h5" stroke-width="2" stroke-linecap="round" fill="none"/></svg>`,
} as const;

export type IconName = keyof typeof ICONS;
