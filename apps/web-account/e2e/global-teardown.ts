import { fileURLToPath } from "node:url";

import { filesHoldingSecrets, removeAll } from "./secrets";

/** Where Playwright writes traces, screenshots, and error context, which CI uploads on failure. */
const RESULTS = fileURLToPath(new URL("../test-results", import.meta.url));

/** Fails the run, and deletes the files, when any result holds one of the core's secrets. */
export default async function noSecretsInResults(): Promise<void> {
  const leaked = await filesHoldingSecrets(RESULTS);

  if (leaked.length === 0) return;
  await removeAll(leaked);

  throw new Error(`Deleted ${leaked.length} test results that held a secret: ${leaked.join(", ")}`);
}
