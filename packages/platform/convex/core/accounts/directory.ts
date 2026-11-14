import { register } from "../../../commands/core/accounts/directory";
import { GUEST_KEYS_FROM } from "../guests/model";
import { paginate } from "../lib/paginate";
import { requireServer } from "../permissions/authorize";

/**
 * The household by name, for picking whom to share with: what old music's `people.directory`
 * gave anyone who could share. Each person's id, the name they go by, and their role; never an
 * email, a restriction, or a guest a link let in. The caller is left out of their own list.
 */
export const { list } = register({
  list: async (ctx, { paginationOpts }, caller) => {
    requireServer(caller, "seePeople");

    const page = await paginate(
      ctx.db,
      {
        table: "users",
        index: "by_kind_username_key",
        range: (q) => q.eq("kind", "person").lt("usernameKey", GUEST_KEYS_FROM),
      },
      paginationOpts,
    );

    return {
      ...page,
      page: page.page.flatMap((user) =>
        user.kind === "person" && user._id !== caller.userId
          ? [{ userId: user._id, name: user.displayName ?? user.username, role: user.role }]
          : [],
      ),
    };
  },
});
