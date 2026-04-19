import * as fs from "fs";
import * as path from "path";

const BEGIN_MARKER = "# === yoso-agent: managed — do not edit by hand ===";
const END_MARKER = "# === end yoso-agent ===";

export function envFilePath(root: string): string {
  return path.resolve(root, ".env");
}

function readFile(root: string): string {
  const p = envFilePath(root);
  return fs.existsSync(p) ? fs.readFileSync(p, "utf-8") : "";
}

function detectLineEnding(content: string): "\n" | "\r\n" {
  const idx = content.indexOf("\n");
  if (idx > 0 && content[idx - 1] === "\r") return "\r\n";
  return "\n";
}

function findBlock(lines: string[]): { begin: number; end: number } | null {
  const begin = lines.findIndex((l) => l.trim() === BEGIN_MARKER);
  if (begin === -1) return null;
  const end = lines.findIndex((l, i) => i > begin && l.trim() === END_MARKER);
  if (end === -1) return null;
  return { begin, end };
}

export interface ReadBlockResult {
  found: boolean;
  entries: Record<string, string>;
}

export function readYosoBlock(root: string): ReadBlockResult {
  const content = readFile(root);
  if (!content) return { found: false, entries: {} };

  const lines = content.split(/\r?\n/);
  const block = findBlock(lines);
  if (!block) return { found: false, entries: {} };

  const entries: Record<string, string> = {};
  for (let i = block.begin + 1; i < block.end; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    entries[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return { found: true, entries };
}

export function hasEnvModeAgent(root: string): boolean {
  return readYosoBlock(root).found;
}

export function hasConflictingKeyOutsideBlock(
  root: string,
  key: string,
  newValue: string
): { conflict: boolean; existingValue?: string } {
  const content = readFile(root);
  if (!content) return { conflict: false };

  const lines = content.split(/\r?\n/);
  const block = findBlock(lines);
  const inBlock = (i: number) => block !== null && i > block.begin && i < block.end;

  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const keyPattern = new RegExp(`^\\s*(?:export\\s+)?${escapedKey}\\s*=\\s*(.*)$`);
  for (let i = 0; i < lines.length; i++) {
    if (inBlock(i)) continue;
    const match = lines[i].match(keyPattern);
    if (!match) continue;
    const raw = match[1].trim();
    const value = raw.replace(/^["']|["']$/g, "");
    if (value !== newValue) {
      return { conflict: true, existingValue: value };
    }
  }
  return { conflict: false };
}

export function writeYosoBlock(root: string, entries: Record<string, string>): void {
  const p = envFilePath(root);
  const existing = readFile(root);
  const le = existing ? detectLineEnding(existing) : "\n";

  const blockLines = [
    BEGIN_MARKER,
    ...Object.entries(entries).map(([k, v]) => `${k}=${v}`),
    END_MARKER,
  ];

  let newContent: string;
  if (!existing) {
    newContent = blockLines.join(le) + le;
  } else {
    const lines = existing.split(/\r?\n/);
    const block = findBlock(lines);

    if (block) {
      const before = lines.slice(0, block.begin);
      const after = lines.slice(block.end + 1);
      newContent = [...before, ...blockLines, ...after].join(le);
    } else {
      const prefix = existing.endsWith(le + le) ? "" : existing.endsWith(le) ? le : le + le;
      newContent = existing + prefix + blockLines.join(le) + le;
    }
  }

  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, newContent, { mode: 0o600 });
  fs.renameSync(tmp, p);
  try {
    fs.chmodSync(p, 0o600);
  } catch {
    /* Windows or permission-restricted FS; best-effort */
  }
}

export function removeYosoBlock(root: string): void {
  const p = envFilePath(root);
  const existing = readFile(root);
  if (!existing) return;

  const le = detectLineEnding(existing);
  const lines = existing.split(/\r?\n/);
  const block = findBlock(lines);
  if (!block) return;

  const before = lines.slice(0, block.begin);
  const after = lines.slice(block.end + 1);
  while (before.length > 0 && before[before.length - 1].trim() === "") before.pop();
  while (after.length > 0 && after[0].trim() === "") after.shift();

  const newContent =
    before.length === 0 && after.length === 0 ? "" : [...before, ...after].join(le) + le;

  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, newContent, { mode: 0o600 });
  fs.renameSync(tmp, p);
}
