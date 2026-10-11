/**
 * Lets plain Node run the workspace's TypeScript sources, whose relative imports omit the `.ts`
 * extension (they are written for bundlers): the media stub imports the media service's real
 * transcoder this way. Load with `node --import ./harness/resolve-ts.ts`.
 */
import { registerHooks } from "node:module";

const RELATIVE = /^\.{1,2}\//u;

const EXTENSION = /\.[cm]?[jt]sx?$/u;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!RELATIVE.test(specifier) || EXTENSION.test(specifier)) {
      return nextResolve(specifier, context);
    }

    return nextResolve(`${specifier}.ts`, context);
  },
});
