let jsonMode = false;

export function setJsonMode(enabled: boolean): void {
  jsonMode = enabled;
}

export function isJsonMode(): boolean {
  return jsonMode;
}

const isTTY = process.stdout.isTTY === true;

const c = {
  bold: (s: string) => (isTTY && !jsonMode ? `\x1b[1m${s}\x1b[0m` : s),
  dim: (s: string) => (isTTY && !jsonMode ? `\x1b[2m${s}\x1b[0m` : s),
  green: (s: string) => (isTTY && !jsonMode ? `\x1b[32m${s}\x1b[0m` : s),
  red: (s: string) => (isTTY && !jsonMode ? `\x1b[31m${s}\x1b[0m` : s),
  yellow: (s: string) => (isTTY && !jsonMode ? `\x1b[33m${s}\x1b[0m` : s),
  cyan: (s: string) => (isTTY && !jsonMode ? `\x1b[36m${s}\x1b[0m` : s),
};

export { c as colors };

export function json(data: unknown): void {
  console.log(JSON.stringify(data, null, jsonMode ? undefined : 2));
}

export function log(msg: string): void {
  if (!jsonMode) console.log(msg);
}

export function error(msg: string): void {
  if (jsonMode) {
    console.error(JSON.stringify({ error: msg }));
  } else {
    console.error(c.red(`Error: ${msg}`));
  }
}

export function success(msg: string): void {
  if (!jsonMode) console.log(c.green(`  ${msg}`));
}

export function warn(msg: string): void {
  if (!jsonMode) console.log(c.yellow(`  Warning: ${msg}`));
}

export function heading(title: string): void {
  if (!jsonMode) {
    console.log(`\n${c.bold(title)}`);
    console.log(c.dim("-".repeat(50)));
  }
}

export function field(label: string, value: string | number | boolean | null | undefined): void {
  if (!jsonMode) {
    console.log(`  ${c.dim(label.padEnd(18))} ${value ?? "-"}`);
  }
}

export function output(data: unknown, humanFormatter: (data: any) => void): void {
  if (jsonMode) {
    json(data);
  } else {
    humanFormatter(data);
  }
}

export function fatal(msg: string): never {
  error(msg);
  process.exit(1);
}

export function formatSymbol(symbol: string): string {
  return symbol[0].startsWith("$") ? symbol : `$${symbol}`;
}
