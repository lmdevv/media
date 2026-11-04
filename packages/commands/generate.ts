import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { refusalMessage } from "./src/check.ts";
import { commands } from "./src/index.ts";
import { drift, driftMessage, plan, write } from "./src/outputs.ts";
import { targets } from "./src/targets.ts";

const repo = fileURLToPath(new URL("../..", import.meta.url));

const platform = join(repo, "packages/platform");

const usage = "usage: node generate.ts [--check]";

const refreshConvexBindings = (): void => {
  if (!existsSync(join(platform, ".env.local"))) {
    process.stderr.write(
      "convex/_generated not refreshed: no dev stack (scripts/dev-stack.sh up); commands/refs.ts fails to compile until a run with the stack refreshes it\n",
    );

    return;
  }

  try {
    execFileSync("pnpm", ["exec", "convex", "codegen", "--typecheck", "disable"], {
      cwd: platform,
      stdio: "pipe",
    });
  } catch (cause) {
    process.stderr.write(
      `convex codegen failed; is the dev stack up (scripts/dev-stack.sh up)?\n${String(cause)}\n`,
    );
    process.exitCode = 1;
  }
};

const run = async (mode: "check" | "write"): Promise<void> => {
  const planned = await plan(commands, targets);

  if (!planned.ok) {
    for (const refusal of planned.refusals) process.stderr.write(`${refusalMessage(refusal)}\n`);

    process.exitCode = 1;

    return;
  }

  if (mode === "check") {
    const differences = await drift(repo, planned.planned);

    for (const difference of differences) process.stderr.write(`${driftMessage(difference)}\n`);

    if (differences.length > 0) process.exitCode = 1;

    return;
  }

  const report = await write(repo, planned.planned);

  if (!report.ok) {
    for (const path of report.foreign) {
      process.stderr.write(`${driftMessage({ kind: "foreign", path })}\n`);
    }

    process.exitCode = 1;

    return;
  }

  process.stdout.write(`${JSON.stringify({ written: report.written, deleted: report.deleted })}\n`);

  refreshConvexBindings();
};

const [flag, ...rest] = process.argv.slice(2);

if (rest.length > 0 || (flag !== undefined && flag !== "--check")) {
  process.stderr.write(`${usage}\n`);
  process.exitCode = 2;
} else {
  await run(flag === "--check" ? "check" : "write");
}
