import { getMyAgentInfo } from "../lib/wallet.js";
import { createSubscription, deleteSubscription } from "../lib/api.js";

export async function list(): Promise<void> {
  const agent = await getMyAgentInfo();
  const tiers = agent.subscriptions ?? [];

  if (tiers.length === 0) {
    console.log("No subscription tiers configured.");
    console.log("Run `yoso-agent sell sub create <name> <price> <duration>` to create one.");
    return;
  }

  console.log(`Subscription tiers for "${agent.name}":\n`);
  for (const tier of tiers) {
    console.log(`  ${tier.name}`);
    console.log(`    Price:    ${tier.price} USDC`);
    console.log(`    Duration: ${Math.round(tier.duration / 86400)} days`);
    console.log();
  }
}

export async function create(
  name: string | undefined,
  price: number | undefined,
  duration: number | undefined
): Promise<void> {
  if (!name) {
    console.error("Error: Missing subscription tier name.");
    console.error("Usage: yoso-agent sell sub create <name> <price> <duration>");
    process.exit(1);
  }
  if (price == null || isNaN(price) || price <= 0) {
    console.error("Error: Price must be a positive number.");
    console.error("Usage: yoso-agent sell sub create <name> <price> <duration>");
    process.exit(1);
  }
  if (duration == null || isNaN(duration) || duration <= 0) {
    console.error("Error: Duration must be a positive number (days).");
    console.error("Usage: yoso-agent sell sub create <name> <price> <duration>");
    process.exit(1);
  }

  const result = await createSubscription({ name, price, duration });

  if (!result.success) {
    console.error("Failed to create subscription tier.");
    process.exit(1);
  }

  console.log(`Subscription tier "${name}" created.`);
  console.log(`  Price:    ${price} USDC`);
  console.log(`  Duration: ${duration} days`);
}

export async function del(name: string | undefined): Promise<void> {
  if (!name) {
    console.error("Error: Missing subscription tier name.");
    console.error("Usage: yoso-agent sell sub delete <name>");
    process.exit(1);
  }

  const result = await deleteSubscription(name);

  if (!result.success) {
    console.error(`Failed to delete subscription tier "${name}".`);
    process.exit(1);
  }

  console.log(`Subscription tier "${name}" deleted.`);
}
