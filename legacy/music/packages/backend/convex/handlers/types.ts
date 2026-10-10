import type {
  CommandArgs,
  CommandResultEncoded,
  MutationName,
  QueryName,
} from "@music/commands/registry";

import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Viewer } from "../lib/viewer";

/** One handler per query command. Handlers return wire values; the dispatcher validates them. */
export type QueryHandlers = {
  readonly [Name in QueryName]: (
    ctx: QueryCtx,
    viewer: Viewer,
    args: CommandArgs<Name>,
  ) => Promise<CommandResultEncoded<Name>>;
};

/** One handler per mutation command. */
export type MutationHandlers = {
  readonly [Name in MutationName]: (
    ctx: MutationCtx,
    viewer: Viewer,
    args: CommandArgs<Name>,
  ) => Promise<CommandResultEncoded<Name>>;
};

export const ok = { ok: true } as const;
