import packageJson from "../../package.json" with { type: "json" };
import { register } from "../../commands/core/server";
import { ownerOf } from "./accounts/users";
import { latestStatus } from "./serverStatus";

const SERVER_NAME = "[media]";

export const { info, status } = register({
  info: async (ctx) => ({
    name: SERVER_NAME,
    version: packageJson.version,
    hasOwner: (await ownerOf(ctx.db)) !== null,
  }),
  status: async (ctx) => latestStatus(ctx.db),
});
