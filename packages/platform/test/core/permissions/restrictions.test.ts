import { describe, expect, it } from "vitest";

import type { Restrictions } from "../../../commands/access";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import {
  movie,
  openProbe,
  seedProbes,
  sessionOf,
  shareProbe,
  song,
  visibleProbes,
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

    const seeded = await seedProbes(stack, manager, [
      movie("G", 0),
      movie("PG", 7),
      movie("PG-13", 13),
      movie("R", 17),
      movie("unrated", null),
      song("explicit", true),
      song("clean", false),
    ]);

    await Promise.all(
      seeded.map(async (probeId) =>
        shareProbe(stack, manager, probeId, { kind: "user", userId: kid.userId }, "view"),
      ),
    );

    const [g, pg, pg13, r, unrated, explicit, clean] = seeded;

    const seen = async (): Promise<ReadonlyArray<Id<"accessProbes"> | undefined>> => {
      const visible = await visibleProbes(stack, kid);

      return seeded.filter((probeId) => visible.includes(probeId));
    };

    expect(await seen()).toEqual(seeded);

    await restrict(admin, kid, { ...NONE, maxMovieAge: 7 });

    expect(await seen()).toEqual([g, pg, unrated, explicit, clean]);

    if (pg13 === undefined || r === undefined) throw new Error("seed made too few probes");

    expect(await refusal(openProbe(stack, kid, pg13))).toBe("not_found");
    expect(await refusal(openProbe(stack, kid, r, "play"))).toBe("not_found");

    await restrict(admin, kid, { ...NONE, maxMovieAge: 7, hideUnrated: true });

    expect(await seen()).toEqual([g, pg, explicit, clean]);

    await restrict(admin, kid, { ...NONE, hideExplicitMusic: true });

    expect(await seen()).toEqual([g, pg, pg13, r, unrated, clean]);

    if (g === undefined || clean === undefined) throw new Error("seed made too few probes");

    await restrict(admin, kid, { ...NONE, libraries: [g, clean, g] });

    expect(await seen()).toEqual([g, clean]);
    expect(
      await kid.signedIn.client.query(api.core.restrictions.get, { userId: kid.userId }),
    ).toEqual({ ...NONE, libraries: [g, clean] });

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

    await restrict(admin, kid, null);
    await admin.signedIn.client.mutation(api.core.accounts.users.setRole, {
      userId: kid.userId,
      role: "admin",
    });

    expect(await refusal(restrict(admin, kid, NONE))).toBe("forbidden");
  });
});
