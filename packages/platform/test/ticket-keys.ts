import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { loadTicketKeyRing, TICKET_KEYS_SETTING } from "@media/contracts/ticket";
import type { TicketKeyRing } from "@media/contracts/ticket";

const platformRoot = fileURLToPath(new URL("..", import.meta.url));

/**
 * The core deployment's own key ring, read with the CLI that set it. The setting's value never
 * reaches a message, an error, or the log.
 */
export const deploymentTicketKeysText = (): string =>
  execFileSync("node_modules/.bin/convex", ["env", "get", TICKET_KEYS_SETTING], {
    cwd: platformRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();

/** The core deployment's own key ring, as `deploymentTicketKeysText` reads it. */
export const deploymentTicketKeys = async (): Promise<TicketKeyRing> => {
  const loaded = await loadTicketKeyRing(deploymentTicketKeysText());

  if (!loaded.ok) throw new Error(`The core's ticket keys are unusable: ${loaded.error.problem}`);

  return loaded.value;
};
