import { describe, expect, it } from "vitest";

import type { Restrictions } from "../../../commands/access";
import { api } from "../../../convex/_generated/api";
import {
  movie,
  openItem,
  openTitle,
  seedLibrary,
  sessionOf,
  share,
  song,
  visibleItems,
  visibleLibraries,
  visibleTitles,
} from "../../probe";
import type { Session } from "../../probe";
import { createPerson, refusal, signInAs } from "../../sign-in";
import { coreStackFromEnvFile } from "../../stack-env";
import type { CoreStack } from "../../stack-env";

const stack = coreStackFromEnvFile();

const NONE: Restrictions = {
  maxMovieAge: null,
  hideUnrated: false,
  hideExplicitMusic: false,
  libraries: null,
};

const signInSession = async (core: CoreStack, label: string, role: "admin" | "member" = "member") =>
  sessionOf(await signInAs(core, await createPerson(core, label, role)));

const restrict = (admin: Session, kid: Session, restrictions: Restrictions | null) =>
  admin.signedIn.client.mutation(api.core.restrictions.set, { userId: kid.userId, restrictions });

describe.skipIf(stack === undefined)("restrictions", { timeout: 120_000 }, () => {
  it("hide what a kid may not see, from lookups and lists, on their next call", async () => {
    if (stack === undefined) return;
    const admin = await signInSession(stack, "admin", "admin");
    const manager = await signInSession(stack, "manager");
    const kid = await signInSession(stack, "kid");

    const films = await seedLibrary(stack, manager, {
      name: "films",
      kind: "movies",
      items: [
        movie("G", 0),
        movie("PG", 7),
        movie("PG-13", 13),
        movie("R", 17),
        movie("unrated", null),
      ],
    });

    const songs = await seedLibrary(stack, manager, {
      name: "songs",
      kind: "music",
      items: [song("explicit", true), song("clean", false)],
    });

    const libraries = [films, songs];

    await Promise.all(
      libraries.map(async ({ libraryId }) =>
        share(manager, libraryId, { kind: "user", userId: kid.userId }, "view"),
      ),
    );

    const seeded: ReadonlyArray<string> = [...films.itemIds, ...songs.itemIds];
    const [g, pg, pg13, r, unrated] = films.itemIds;
    const [explicit, clean] = songs.itemIds;

    const seen = async (): Promise<ReadonlyArray<string>> => {
      const listed = await visibleLibraries(kid);

      const visible = new Set<string>([
        ...(listed.includes(films.libraryId)
          ? await visibleTitles(stack, kid, films.libraryId)
          : []),
        ...(listed.includes(songs.libraryId)
          ? await visibleItems(stack, kid, songs.libraryId)
          : []),
      ]);

      return seeded.filter((itemId) => visible.has(itemId));
    };

    expect(await seen()).toEqual(seeded);

    await restrict(admin, kid, { ...NONE, maxMovieAge: 7 });

    expect(await seen()).toEqual([g, pg, unrated, explicit, clean]);

    if (pg13 === undefined || r === undefined || clean === undefined) {
      throw new Error("seed made too few items");
    }

    expect(await refusal(openTitle(stack, kid, pg13))).toBe("not_found");
    expect(await refusal(openTitle(stack, kid, r, "play"))).toBe("not_found");

    await restrict(admin, kid, { ...NONE, maxMovieAge: 7, hideUnrated: true });

    expect(await seen()).toEqual([g, pg, explicit, clean]);

    await restrict(admin, kid, { ...NONE, hideExplicitMusic: true });

    expect(await seen()).toEqual([g, pg, pg13, r, unrated, clean]);

    await restrict(admin, kid, {
      ...NONE,
      libraries: [films.libraryId, films.libraryId],
    });

    const listed = await visibleLibraries(kid);

    expect([listed.includes(films.libraryId), listed.includes(songs.libraryId)]).toEqual([
      true,
      false,
    ]);
    expect(await seen()).toEqual(films.itemIds);
    expect(await refusal(visibleItems(stack, kid, songs.libraryId))).toBe("not_found");
    expect(await refusal(openItem(stack, kid, clean, "play"))).toBe("not_found");
    expect(
      await refusal(
        kid.signedIn.client.query(api.core.libraries.get, { libraryId: songs.libraryId }),
      ),
    ).toBe("not_found");
    expect(
      await kid.signedIn.client.query(api.core.restrictions.get, { userId: kid.userId }),
    ).toEqual({ ...NONE, libraries: [films.libraryId] });

    await restrict(admin, kid, null);

    expect(await seen()).toEqual(seeded);
    expect(
      await kid.signedIn.client.query(api.core.restrictions.get, { userId: kid.userId }),
    ).toBeNull();
  });

  it("are set only by an admin, on a member who is not themselves", async () => {
    if (stack === undefined) return;
    const admin = await signInSession(stack, "admin", "admin");
    const otherAdmin = await signInSession(stack, "admin", "admin");
    const kid = await signInSession(stack, "kid");
    const member = await signInSession(stack, "member");

    await restrict(admin, kid, { ...NONE, maxMovieAge: 7 });

    expect(await refusal(restrict(kid, kid, null))).toBe("forbidden");
    expect(await refusal(restrict(admin, admin, NONE))).toBe("forbidden");
    expect(await refusal(restrict(admin, otherAdmin, NONE))).toBe("forbidden");
    expect(await refusal(restrict(admin, kid, { ...NONE, maxMovieAge: 22 }))).toBe("invalid_args");
    expect(await refusal(restrict(admin, kid, { ...NONE, maxMovieAge: 6.5 }))).toBe("invalid_args");
    expect(
      await refusal(
        member.signedIn.client.query(api.core.restrictions.get, { userId: kid.userId }),
      ),
    ).toBe("forbidden");
    expect(
      await admin.signedIn.client.query(api.core.restrictions.get, { userId: kid.userId }),
    ).toEqual({ ...NONE, maxMovieAge: 7 });
    expect(
      await refusal(
        admin.signedIn.client.mutation(api.core.accounts.users.setRole, {
          userId: kid.userId,
          role: "admin",
        }),
      ),
    ).toBe("forbidden");
    expect(
      await refusal(
        admin.signedIn.client.mutation(api.core.accounts.users.setRole, {
          userId: kid.userId,
          role: "member",
        }),
      ),
    ).toBe("accepted");
    expect(
      await admin.signedIn.client.query(api.core.restrictions.get, { userId: otherAdmin.userId }),
    ).toBeNull();

    await restrict(admin, kid, NONE);

    expect(
      await admin.signedIn.client.query(api.core.restrictions.get, { userId: kid.userId }),
    ).toBeNull();
    await admin.signedIn.client.mutation(api.core.accounts.users.setRole, {
      userId: kid.userId,
      role: "admin",
    });

    expect(await refusal(restrict(admin, kid, NONE))).toBe("forbidden");
  });
});
