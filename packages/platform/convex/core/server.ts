import packageJson from "../../package.json" with { type: "json" };
import { register } from "../../commands/core/server";
import { ownerOf } from "./accounts/users";

const SERVER_NAME = "[media]";

export const { info } = register({
  info: async (ctx) => ({
    name: SERVER_NAME,
    version: packageJson.version,
    hasOwner: (await ownerOf(ctx.db)) !== null,
  }),
});
