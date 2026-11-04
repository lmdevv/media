import { eslintCompatPlugin } from "@oxlint/plugins";

import { noRawGhRule } from "./rules/no-raw-gh.ts";
import { noTryCatchInEffectGeneratorsRule } from "./rules/no-try-catch-in-effect-generators.ts";
import { preferPlatformServicesRule } from "./rules/prefer-platform-services.ts";

const timmoEffectPlugin = eslintCompatPlugin({
  meta: { name: "timmo-effect" },
  rules: {
    "no-raw-gh": noRawGhRule,
    "no-try-catch-in-effect-generators": noTryCatchInEffectGeneratorsRule,
    "prefer-platform-services": preferPlatformServicesRule,
  },
});

export default timmoEffectPlugin;
