/**
 * Zip files, made and read in the page.
 *
 * Small on purpose: the pad's own files go out as a zip and a zip's files come
 * in, and nothing else. Deflate is the browser's own (`CompressionStream`), so
 * there is no library to ship; a browser without it writes the entries stored
 * instead, which every unzip reads. Read: stored and deflated entries, with
 * names in UTF-8 or the old code page. Not read: encrypted entries and ZIP64,
 * neither of which a pad's limits could hold anyway.
 *
 * A zip says how big each entry will be before it is opened, and those sizes
 * are checked against the pad's limits before anything is inflated — and
 * again while inflating, since a hostile zip can say anything.
 */
import { ignored } from "./sync";

export interface ZipEntry {
  path: string;
  data: Uint8Array;
}

export class ZipError extends Error {}

/** A pad's own limits, which an import is held to before anything is sent. */
export const PAD_LIMITS = { maxFiles: 500, maxBytes: 25 * 1024 * 1024 };

/** Ask for a zip from this computer. Null when the person thinks better of it. */
export function pickZip(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".zip,application/zip,application/x-zip-compressed";
    input.addEventListener("change", () => resolve(input.files?.[0] ?? null), { once: true });
    input.addEventListener("cancel", () => resolve(null), { once: true });
    input.click();
  });
}

/** What an import left out, in words — empty when it left nothing out. */
export function leftOut(p: { binary: string[]; unsafe: string[] }): string {
  const parts: string[] = [];
  if (p.binary.length) parts.push(`${p.binary.length} binary ${p.binary.length === 1 ? "file" : "files"} (a pad holds text)`);
  if (p.unsafe.length) parts.push(`${p.unsafe.length} with ${p.unsafe.length === 1 ? "a path" : "paths"} outside the folder`);
  return parts.length ? `left out ${parts.join(" and ")}` : "";
}

// ------------------------------------------------------------------ crc

let table: Uint32Array | null = null;

export function crc32(data: Uint8Array): number {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = table[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

async function through(data: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Blob([data as BlobPart]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

const canDeflate = () => typeof CompressionStream === "function";

// ---------------------------------------------------------------- write

/** MS-DOS time and date, which is all a zip entry has room for. */
function dosTime(d: Date): [number, number] {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return [time, date];
}

export async function makeZip(entries: ZipEntry[], when = new Date()): Promise<Blob> {
  const enc = new TextEncoder();
  const [time, date] = dosTime(when);
  const parts: BlobPart[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.path);
    const crc = crc32(e.data);
    // Deflated when it helps; stored when it does not, or cannot.
    let method = 0;
    let body = e.data;
    if (canDeflate() && e.data.length > 64) {
      const packed = await through(e.data, new CompressionStream("deflate-raw"));
      if (packed.length < e.data.length) {
        method = 8;
        body = packed;
      }
    }
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // names are UTF-8
    local.setUint16(8, method, true);
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, body.length, true);
    local.setUint32(22, e.data.length, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    parts.push(local.buffer, name as BlobPart, body as BlobPart);

    const cd = new DataView(new ArrayBuffer(46 + name.length));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 0x031e, true); // made by: Unix, spec 3.0
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, method, true);
    cd.setUint16(12, time, true);
    cd.setUint16(14, date, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, body.length, true);
    cd.setUint32(24, e.data.length, true);
    cd.setUint16(28, name.length, true);
    cd.setUint32(38, (0o100644 << 16) >>> 0, true); // a regular file, rw-r--r--
    cd.setUint32(42, offset, true);
    new Uint8Array(cd.buffer).set(name, 46);
    central.push(new Uint8Array(cd.buffer));
    offset += 30 + name.length + body.length;
  }
  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...(central as BlobPart[]), end.buffer], { type: "application/zip" });
}

// ----------------------------------------------------------------- read

export interface ReadLimits {
  /** Entries that are files, not counting directories. */
  maxFiles: number;
  /** Bytes once inflated, all entries together. */
  maxBytes: number;
}

/** The old code page names were written in, before the UTF-8 flag. */
const CP437 =
  "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ";
function cp437(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b < 128 ? String.fromCharCode(b) : CP437[b - 128];
  return s;
}

export async function readZip(blob: Blob, limits: ReadLimits): Promise<ZipEntry[]> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // The end record is in the last 64 KB plus its own size, behind any comment.
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new ZipError("that is not a zip file");
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  if (count === 0xffff || at === 0xffffffff) throw new ZipError("that zip is too big for a pad (ZIP64)");

  const utf8 = new TextDecoder();
  const found: { path: string; method: number; packed: number; size: number; crc: number; local: number }[] = [];
  let declared = 0;
  for (let i = 0; i < count; i++) {
    if (at + 46 > buf.length || view.getUint32(at, true) !== 0x02014b50) throw new ZipError("that zip is damaged");
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const packed = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const raw = buf.subarray(at + 46, at + 46 + nameLen);
    const path = flags & 0x0800 ? utf8.decode(raw) : cp437(raw);
    at += 46 + nameLen + extraLen + commentLen;
    if (path.endsWith("/")) continue; // a directory: implied by what is in it
    if (flags & 0x0001) throw new ZipError("that zip is password-protected");
    if (method !== 0 && method !== 8) throw new ZipError(`that zip uses a compression a browser cannot open (method ${method})`);
    declared += size;
    found.push({ path, method, packed, size, crc, local });
  }
  // Before anything is inflated: what the zip says it holds.
  if (found.length > limits.maxFiles) throw new ZipError(`that zip has ${found.length} files; a pad holds at most ${limits.maxFiles}`);
  if (declared > limits.maxBytes) throw new ZipError(`that zip holds ${Math.round(declared / 1048576)} MB once unpacked; a pad holds at most ${Math.round(limits.maxBytes / 1048576)} MB`);

  const out: ZipEntry[] = [];
  let total = 0;
  for (const f of found) {
    if (view.getUint32(f.local, true) !== 0x04034b50) throw new ZipError("that zip is damaged");
    const start = f.local + 30 + view.getUint16(f.local + 26, true) + view.getUint16(f.local + 28, true);
    const body = buf.subarray(start, start + f.packed);
    if (body.length !== f.packed) throw new ZipError("that zip is cut short");
    const data = f.method === 8 ? await through(body, new DecompressionStream("deflate-raw")) : body.slice();
    // And again after: a zip that lied about its sizes is stopped here.
    total += data.length;
    if (data.length !== f.size || total > limits.maxBytes) throw new ZipError("that zip's sizes do not add up");
    if (crc32(data) !== f.crc) throw new ZipError(`that zip is damaged (${f.path})`);
    out.push({ path: f.path, data });
  }
  return out;
}

// --------------------------------------------------------------- import

export interface Prepared {
  /** Text files, ready to write into a pad. */
  files: { path: string; content: string }[];
  /** Binary files left out — a pad and its sandbox hold text. */
  binary: string[];
  /** Paths that cannot be a pad's — `..`, absolute — left out. */
  unsafe: string[];
  /** The folder every entry was inside, taken off. */
  root: string | null;
}

/** What zips carry that nobody wants in a pad. */
function junk(path: string): boolean {
  const parts = path.split("/");
  return (
    parts[0] === "__MACOSX" ||
    parts.some((p) => p === ".DS_Store" || p === "Thumbs.db" || p === "desktop.ini" || p.startsWith("._")) ||
    ignored(path)
  );
}

/** The store's own rule for a path, so nothing is sent that it would refuse. */
function safe(path: string): boolean {
  // 512 bytes, as the relay counts, not characters.
  if (!path || new TextEncoder().encode(path).length > 512 || path.startsWith("/")) return false;
  return path.split("/").every((p) => p !== "" && p !== "." && p !== ".." && !/[\u0000-\u001f\\]/.test(p));
}

/**
 * A zip's entries as a pad's files: junk out, one wrapping folder off — a
 * GitHub download is all inside `repo-main/` — unsafe paths out, and text
 * apart from binary.
 */
export function prepareImport(entries: ZipEntry[]): Prepared {
  const kept = entries.map((e) => ({ ...e, path: e.path.replace(/\\/g, "/") })).filter((e) => !junk(e.path));
  const tops = new Set(kept.map((e) => e.path.split("/")[0]));
  const wrapped = tops.size === 1 && kept.length > 0 && kept.every((e) => e.path.includes("/"));
  const root = wrapped ? [...tops][0]! : null;
  const result: Prepared = { files: [], binary: [], unsafe: [], root };
  const text = new TextDecoder("utf-8", { fatal: true });
  for (const e of kept) {
    const path = root ? e.path.slice(root.length + 1) : e.path;
    if (!safe(path)) {
      result.unsafe.push(e.path);
      continue;
    }
    let content: string | null = null;
    try {
      content = e.data.includes(0) ? null : text.decode(e.data);
    } catch {
      content = null;
    }
    if (content === null) result.binary.push(path);
    else result.files.push({ path, content });
  }
  return result;
}

/** Hand the person a file, as if they had clicked a link to it. */
export function save(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
