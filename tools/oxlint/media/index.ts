import { eslintCompatPlugin } from "@oxlint/plugins";

import { moviesWriterRule } from "./rules/movies-writer.ts";

/** This repo's own Oxlint rules. */
const mediaPlugin = eslintCompatPlugin({
  meta: { name: "media" },
  rules: {
    "movies-writer": moviesWriterRule,
  },
});

export default mediaPlugin;
