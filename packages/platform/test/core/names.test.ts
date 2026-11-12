import { ConvexHttpClient } from "convex/browser";
import { describe, expect, it } from "vitest";

import { api } from "../../convex/_generated/api";
import { enroll } from "../devices";
import { allPages } from "../pages";
import type { PageLoader } from "../pages";
import { createPerson, refusal, signInAs, unique } from "../sign-in";
import type { SignedIn } from "../sign-in";
import { coreStackFromEnvFile } from "../stack-env";

const stack = coreStackFromEnvFile();

/** Names no one else should be shown: reordered, rung, invisible, and 65 code points long. */
const REFUSED = ["Den ‮vt‬", "Den\u0007", "​​", "\u{1F4FA}".repeat(65)];

/** Fullwidth letters, which NFKC turns into the plain ones. */
const FULLWIDTH = "Ｌｉｖｉｎｇ Room";

/** 64 code points that take 128 UTF-16 units. */
const WIDE = "\u{1F4FA}".repeat(64);

const named = async <T extends { readonly name: string }>(
  load: PageLoader<T>,
  matches: (row: T) => boolean,
): Promise<string | undefined> =>
  (await allPages(load, 100)).flatMap((page) => page.page).find(matches)?.name;

const createLibrary = (admin: SignedIn, name: string) =>
  admin.client.mutation(api.core.libraries.create, {
    name,
    kind: "movies",
    folders: [`/srv/names-${unique()}`],
  });

describe.skipIf(stack === undefined)("names other people see", { timeout: 180_000 }, () => {
  it("refuse a device, group, library, or key name that breaks the guest-name rule", async () => {
    if (stack === undefined) return;
    const admin = await signInAs(stack, await createPerson(stack, "admin", "admin"));

    const { libraryId } = await createLibrary(admin, "Films");

    const { groupId } = await admin.client.mutation(api.core.permissions.groups.create, {
      name: `Family ${unique()}`,
    });

    const anonymous = new ConvexHttpClient(stack.url, { logger: false });

    const setters = {
      library: (name: string) => createLibrary(admin, name),
      libraryRename: (name: string) =>
        admin.client.mutation(api.core.libraries.rename, { libraryId, name }),
      group: (name: string) => admin.client.mutation(api.core.permissions.groups.create, { name }),
      groupRename: (name: string) =>
        admin.client.mutation(api.core.permissions.groups.rename, { groupId, name }),
      key: (name: string) =>
        admin.client.action(api.core.auth.apiKeys.create, { name, scopes: ["movies:read"] }),
      device: (name: string) => enroll(admin, name),
      grant: (name: string) => admin.client.action(api.core.devices.deviceGrants.issue, { name }),
      deviceCode: (clientName: string) =>
        anonymous.action(api.core.auth.deviceCodes.start, { clientName }),
    };

    const answersTo = async (name: string) => ({
      name,
      answers: Object.fromEntries(
        await Promise.all(
          Object.entries(setters).map(
            async ([setter, set]) => [setter, await refusal(set(name))] as const,
          ),
        ),
      ),
    });

    expect(await Promise.all(REFUSED.map(answersTo))).toEqual(
      REFUSED.map((name) => ({
        name,
        answers: Object.fromEntries(Object.keys(setters).map((key) => [key, "invalid_args"])),
      })),
    );
  });

  it("keep a name in NFKC form, counting code points rather than UTF-16 units", async () => {
    if (stack === undefined) return;
    const admin = await signInAs(stack, await createPerson(stack, "admin", "admin"));

    const { libraryId } = await createLibrary(admin, FULLWIDTH);

    expect(await admin.client.query(api.core.libraries.get, { libraryId })).toMatchObject({
      name: "Living Room",
    });

    await admin.client.mutation(api.core.libraries.rename, { libraryId, name: WIDE });

    expect(await admin.client.query(api.core.libraries.get, { libraryId })).toMatchObject({
      name: WIDE,
    });

    const suffix = unique();

    const { groupId } = await admin.client.mutation(api.core.permissions.groups.create, {
      name: `${FULLWIDTH} ${suffix}`,
    });

    expect(
      await named(
        (paginationOpts) =>
          admin.client.query(api.core.permissions.groups.list, { paginationOpts }),
        (group) => group.groupId === groupId,
      ),
    ).toBe(`Living Room ${suffix}`);

    const device = await enroll(admin, FULLWIDTH);

    expect(
      await named(
        (paginationOpts) => admin.client.query(api.core.devices.registry.list, { paginationOpts }),
        (row) => row.deviceId === device.deviceId,
      ),
    ).toBe("Living Room");

    const { grantId } = await admin.client.action(api.core.devices.deviceGrants.issue, {
      name: WIDE,
    });

    expect(
      await named(
        (paginationOpts) =>
          admin.client.query(api.core.devices.deviceGrants.list, { paginationOpts }),
        (row) => row.grantId === grantId,
      ),
    ).toBe(WIDE);

    expect(
      await refusal(
        admin.client.action(api.core.auth.apiKeys.create, { name: WIDE, scopes: ["movies:read"] }),
      ),
    ).toBe("accepted");

    const started = await new ConvexHttpClient(stack.url, { logger: false }).action(
      api.core.auth.deviceCodes.start,
      { clientName: FULLWIDTH },
    );

    expect(
      await admin.client.query(api.core.auth.deviceCodes.lookup, { userCode: started.userCode }),
    ).toMatchObject({ clientName: "Living Room" });
  });
});
