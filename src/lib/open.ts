import { execFile } from "child_process";

export function openUrl(url: string): void {
  const platform = process.platform;

  let bin: string;
  let args: string[];

  if (platform === "darwin") {
    bin = "open";
    args = [url];
  } else if (platform === "win32") {
    bin = "cmd";
    args = ["/c", "start", "", url];
  } else {
    bin = "xdg-open";
    args = [url];
  }

  execFile(bin, args, () => {
    // Callers print the URL, so browser launch errors are non-fatal.
  });
}
