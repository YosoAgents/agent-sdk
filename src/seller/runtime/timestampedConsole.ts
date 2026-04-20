import util from "node:util";

let patched = false;

export function formatWithTimestamp(args: unknown[], now: () => Date = () => new Date()): string {
  const ts = `[${now().toISOString()}]`;
  const text = util.format(...args);
  return text
    .split("\n")
    .map((line) => (line.length > 0 ? `${ts} ${line}` : line))
    .join("\n");
}

export function installTimestampedConsole(): void {
  if (patched) return;
  patched = true;
  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);
  console.log = (...args: unknown[]) => origLog(formatWithTimestamp(args));
  console.warn = (...args: unknown[]) => origWarn(formatWithTimestamp(args));
  console.error = (...args: unknown[]) => origError(formatWithTimestamp(args));
}
