import { eslintCompatPlugin } from "@oxlint/plugins";

import { moviesWriterRule } from "./rules/movies-writer.ts";
import { musicWriterRule } from "./rules/music-writer.ts";

/** This repo's own Oxlint rules. */
const mediaPlugin = eslintCompatPlugin({
  meta: { name: "media" },
  rules: {
    "movies-writer": moviesWriterRule,
    "music-writer": musicWriterRule,
  },
});

export default mediaPlugin;
