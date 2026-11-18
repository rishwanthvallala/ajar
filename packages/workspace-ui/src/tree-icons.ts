/**
 * The file tree's icons, which both products' trees draw: a file, a folder,
 * and what the bar over them and each row's buttons do. Inline SVG that
 * follows `currentColor`, on a 16-unit grid at 1.2.
 */
export const TREE_ICONS = {
  file: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9 1.5H4.5A1.5 1.5 0 0 0 3 3v10a1.5 1.5 0 0 0 1.5 1.5h7A1.5 1.5 0 0 0 13 13V5.5L9 1.5Z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M9 1.5V5a.5.5 0 0 0 .5.5H13" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>`,
  folder: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.2a1 1 0 0 1 .7.3l1 1a1 1 0 0 0 .7.3h4.4A1.5 1.5 0 0 1 14 6.1v6.4A1.5 1.5 0 0 1 12.5 14h-9A1.5 1.5 0 0 1 2 12.5v-8Z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>`,
  newFile: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8.5 1.5H4.5A1.5 1.5 0 0 0 3 3v10a1.5 1.5 0 0 0 1.5 1.5h7A1.5 1.5 0 0 0 13 13V6" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M11.5 1.5v4M9.5 3.5h4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>`,
  history: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.6 8a5.4 5.4 0 1 0 1.6-3.8" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><path d="M2.4 2.3v2.6H5" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M8 5v3.2l2.1 1.3" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  newFolder: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.2a1 1 0 0 1 .7.3l1 1a1 1 0 0 0 .7.3h2.4" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M2 4.5v8A1.5 1.5 0 0 0 3.5 14h9a1.5 1.5 0 0 0 1.5-1.5V9" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M12.5 2.5v4M10.5 4.5h4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>`,
  chevron: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  download: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5v8M4.8 7.3 8 10.5l3.2-3.2M3 13.5h10" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  upload: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 10.5v-8M4.8 5.7 8 2.5l3.2 3.2M3 13.5h10" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  rename: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10.6 2.6a1.4 1.4 0 0 1 2 2L5.4 11.8 2.5 12.5l.7-2.9 7.4-7Z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M9.4 3.8l2 2M8.5 13.5h5" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>`,
  trash: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4h11M6.5 4V2.5h3V4M4 4l.6 9a1.5 1.5 0 0 0 1.5 1.4h3.8a1.5 1.5 0 0 0 1.5-1.4L12 4M6.5 6.5v5M9.5 6.5v5" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
} as const;
