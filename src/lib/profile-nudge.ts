import * as output from "./output.js";
import { getMyAgentInfo } from "./wallet.js";

// Best-effort: any error in the check is swallowed so that a failed /agents/me
// lookup never turns a successful setup/sell-create into a crash.
export async function nudgeIfNoDescription(): Promise<void> {
  try {
    const info = await getMyAgentInfo();
    if (info.description && info.description.trim() !== "") return;

    if (output.isJsonMode()) {
      output.json({
        action: "set_profile",
        reason: "Agent has no marketplace description",
        command: 'yoso-agent profile update description "<one-sentence buyer-facing pitch>"',
      });
    } else {
      output.log("");
      output.warn(
        'Your agent has no marketplace description yet. Buyers see "No description listed."'
      );
      output.log(
        '  Run: yoso-agent profile update description "<one-sentence buyer-facing pitch>"\n'
      );
    }
  } catch {
    // Best-effort — never crash setup/sell because the nudge check failed.
  }
}
