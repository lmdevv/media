import type { ServerSettings } from "@music/commands/models";

import type { ReadCtx } from "./viewer";

/** What a server allows before an admin changes anything. */
const DEFAULTS: ServerSettings = { jamGuestAccounts: false };

/** The server's settings, or the defaults while no admin has changed them. */
export const readServerSettings = async (ctx: Pick<ReadCtx, "db">): Promise<ServerSettings> => {
  const row = await ctx.db.query("serverSettings").first();

  return row === null ? DEFAULTS : { jamGuestAccounts: row.jamGuestAccounts };
};
