import type { Target } from "./outputs.ts";
import { cliTarget } from "./targets/cli.ts";
import { platformTarget } from "./targets/platform.ts";
import { sdkTarget } from "./targets/sdk.ts";
import { skillTarget } from "./targets/skill.ts";

/** Every output the generator writes, each owning one folder of the repo. */
export const targets: ReadonlyArray<Target> = [
  platformTarget("packages/platform/commands"),
  sdkTarget("packages/sdk/src/platform/generated"),
  skillTarget("apps/cli/skills/media/references"),
  cliTarget("apps/cli/src/generated"),
];
