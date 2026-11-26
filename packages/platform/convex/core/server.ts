import packageJson from "../../package.json" with { type: "json" };
import { register } from "../../commands/core/server";
import { ownerOf } from "./accounts/users";
import { latestPresence, latestStatus } from "./serverStatus";

const SERVER_NAME = "Lar";

export const { info, presence, status } = register({
  info: async (ctx) => ({
    name: SERVER_NAME,
    version: packageJson.version,
    hasOwner: (await ownerOf(ctx.db)) !== null,
  }),
  presence: async (ctx) => latestPresence(ctx.db),
  status: async (ctx) => latestStatus(ctx.db),
});
