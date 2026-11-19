/* Minimal ZIP reader (no dependencies) for chat exports: finds one entry by
 * name and returns its bytes. Supports stored and deflate entries, which is
 * what ChatGPT and Claude exports use. ZIP64 archives are not supported. */
import * as fs from "node:fs";
import { inflateRawSync } from "node:zlib";

export function isZip(buf: Buffer): boolean {
  return buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50;
}

/** Names of all entries in the archive. */
export function zipEntries(buf: Buffer): string[] {
  return centralDirectory(buf).map((e) => e.name);
}

interface Entry {
  name: string;
  method: number;
  compressedSize: number;
  localOffset: number;
}

function centralDirectory(buf: Buffer): Entry[] {
  // End of central directory: last 22..65557 bytes.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip file (no end of central directory)");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (p === 0xffffffff) throw new Error("ZIP64 archives are not supported; unzip the export and import conversations.json");
  const out: Entry[] = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("corrupt zip central directory");
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    out.push({ name, method, compressedSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** Bytes of the first entry whose path ends with `name` (e.g. "conversations.json"). */
export function readZipEntry(buf: Buffer, name: string): Buffer | null {
  const entry = centralDirectory(buf).find((e) => e.name === name || e.name.endsWith("/" + name));
  if (!entry) return null;
  const lh = entry.localOffset;
  if (buf.readUInt32LE(lh) !== 0x04034b50) throw new Error("corrupt zip local header");
  const start = lh + 30 + buf.readUInt16LE(lh + 26) + buf.readUInt16LE(lh + 28);
  const data = buf.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return Buffer.from(data);
  if (entry.method === 8) return inflateRawSync(data);
  throw new Error(`unsupported zip compression method ${entry.method}`);
}

export function readFileOrZipEntry(file: string, name: string): string {
  const buf = fs.readFileSync(file);
  if (!isZip(buf)) return buf.toString("utf8");
  const entry = readZipEntry(buf, name);
  if (!entry) throw new Error(`${name} not found in ${file}`);
  return entry.toString("utf8");
}
