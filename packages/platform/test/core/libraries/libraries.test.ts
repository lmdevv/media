import { join } from "node:path";

import { ConvexError } from "convex/values";
import { Schema } from "effect";
import { afterAll, describe, expect, it } from "vitest";

import { api, internal } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { runFunction } from "../../admin";
import { createPerson, refusal, signInAs } from "../../sign-in";
import type { SignedIn } from "../../sign-in";
import { coreStackFromEnvFile } from "../../stack-env";
import type { CoreStack } from "../../stack-env";
import { makeTree, removeTree } from "./files";
import { claimScanOf, scanCalls, scanLibrary } from "./scanner";

const stack = coreStackFromEnvFile();

const roots: Array<string> = [];

const tree = async (files: ReadonlyArray<string>): Promise<string> => {
  const root = await makeTree(files);

  roots.push(root);

  return root;
};

afterAll(async () => {
  await Promise.all(roots.map(removeTree));
});

interface Person {
  readonly client: SignedIn["client"];
  readonly userId: Id<"users">;
}

const person = async (
  core: CoreStack,
  label: string,
  role: "admin" | "member" = "member",
): Promise<Person> => {
  const signedIn = await signInAs(core, await createPerson(core, label, role));
  const current = await signedIn.client.query(api.core.auth.sessions.current, {});

  return { client: signedIn.client, userId: current.userId };
};

const JobPayload = Schema.Struct({ payload: Schema.Struct({ kind: Schema.String }) });

const jobKind = async (core: CoreStack, jobId: Id<"jobs">): Promise<string> =>
  (await runFunction(core, internal.core.jobs.admin.get, { jobId }, JobPayload)).payload.kind;

const listed = async (who: Person): Promise<ReadonlyArray<Id<"libraries">>> =>
  (
    await who.client.query(api.core.libraries.list, {
      paginationOpts: { numItems: 1000, cursor: null },
    })
  ).page.map((row) => row.libraryId);

const sees = async (who: Person, libraryId: Id<"libraries">) => ({
  get: await refusal(who.client.query(api.core.libraries.get, { libraryId })),
  listed: (await listed(who)).includes(libraryId),
});

const create = (who: Person, kind: "movies" | "music", folders: ReadonlyArray<string>) =>
  who.client.mutation(api.core.libraries.create, {
    name: `${kind} ${Math.random().toString(36).slice(2, 6)}`,
    kind,
    folders: [...folders],
  });

const messageOf = async (call: Promise<unknown>): Promise<string> =>
  call.then(
    () => "accepted",
    (cause: unknown) => (cause instanceof ConvexError ? JSON.stringify(cause.data) : String(cause)),
  );

describe.skipIf(stack === undefined)("libraries", { timeout: 180_000 }, () => {
  it("are made private by an admin, and queue only their own domain's scan", async () => {
    if (stack === undefined) return;
    const owner = await person(stack, "owner", "admin");
    const otherAdmin = await person(stack, "admin", "admin");
    const folder = await tree(["Album/01.flac"]);
    const { libraryId, scanJobId } = await create(owner, "music", [`${folder}//`]);

    expect(await jobKind(stack, scanJobId)).toBe("music.scan");
    expect(await owner.client.query(api.core.libraries.get, { libraryId })).toMatchObject({
      kind: "music",
      level: "manage",
      items: 0,
      folders: [folder],
      scan: { jobId: scanJobId, status: "queued" },
    });
    expect(await sees(otherAdmin, libraryId)).toEqual({ get: "not_found", listed: false });
    expect(
      await refusal(
        otherAdmin.client.mutation(api.core.permissions.grants.set, {
          resource: { type: "library", id: libraryId },
          principal: { kind: "user", userId: otherAdmin.userId },
          level: "view",
        }),
      ),
    ).toBe("not_found");

    expect(await refusal(create(await person(stack, "member"), "movies", ["/srv"]))).toBe(
      "forbidden",
    );
  });

  it("never share a folder, and neither a folder nor a taken name tells of another library", async () => {
    if (stack === undefined) return;
    const owner = await person(stack, "owner", "admin");
    const otherAdmin = await person(stack, "admin", "admin");
    const root = await tree(["films/a.mkv", "film/b.mkv"]);
    const first = await create(owner, "movies", [join(root, "films")]);

    const { name } = await owner.client.query(api.core.libraries.get, {
      libraryId: first.libraryId,
    });

    const refusals = await Promise.all(
      [[root], [join(root, "films")], [join(root, "films", "kids")]].map(async (folders) =>
        messageOf(create(otherAdmin, "music", folders)),
      ),
    );

    for (const refused of refusals) {
      expect(refused).toContain('"code":"conflict"');
      expect(refused).not.toContain(name);
      expect(refused).not.toContain(first.libraryId);
    }

    expect(
      await refusal(
        otherAdmin.client.mutation(api.core.libraries.create, {
          name,
          kind: "movies",
          folders: [join(root, "film")],
        }),
      ),
    ).toBe("accepted");
    expect(
      await refusal(create(otherAdmin, "movies", [join(root, "x"), join(root, "x", "y")])),
    ).toBe("invalid_args");
    expect(await refusal(create(otherAdmin, "movies", ["relative/path"]))).toBe("invalid_args");

    await owner.client.mutation(api.core.libraries.remove, { libraryId: first.libraryId });

    expect(await refusal(create(otherAdmin, "music", [join(root, "films")]))).toBe("accepted");
  });

  it("reach only who they are shared with, at the level shared", async () => {
    if (stack === undefined) return;
    const owner = await person(stack, "owner", "admin");
    const friend = await person(stack, "friend");
    const stranger = await person(stack, "stranger");
    const { libraryId } = await create(owner, "movies", [await tree(["a.mkv"])]);
    const resource = { type: "library", id: libraryId } as const;

    await owner.client.mutation(api.core.permissions.grants.set, {
      resource,
      principal: { kind: "user", userId: friend.userId },
      level: "view",
    });

    expect(await sees(friend, libraryId)).toEqual({ get: "accepted", listed: true });
    expect(await sees(stranger, libraryId)).toEqual({ get: "not_found", listed: false });
    expect(await friend.client.query(api.core.libraries.get, { libraryId })).toMatchObject({
      level: "view",
      items: 0,
      folders: null,
    });

    await owner.client.mutation(api.core.restrictions.set, {
      userId: friend.userId,
      restrictions: {
        maxMovieAge: 7,
        hideUnrated: false,
        hideExplicitMusic: false,
        libraries: null,
      },
    });

    expect(await friend.client.query(api.core.libraries.get, { libraryId })).toMatchObject({
      items: null,
      scan: { status: "queued", done: null, total: null },
    });

    await owner.client.mutation(api.core.restrictions.set, {
      userId: friend.userId,
      restrictions: null,
    });
    expect(await refusal(friend.client.mutation(api.core.libraries.scan, { libraryId }))).toBe(
      "forbidden",
    );
    expect(
      await refusal(
        friend.client.query(api.core.permissions.grants.list, {
          resource,
          paginationOpts: { numItems: 10, cursor: null },
        }),
      ),
    ).toBe("forbidden");
    expect(
      (
        await owner.client.query(api.core.permissions.grants.list, {
          resource,
          paginationOpts: { numItems: 10, cursor: null },
        })
      ).page.map((row) => [row.principal.kind, row.level]),
    ).toEqual(
      expect.arrayContaining([
        ["user", "manage"],
        ["user", "view"],
      ]),
    );

    await owner.client.mutation(api.core.permissions.grants.set, {
      resource,
      principal: { kind: "user", userId: friend.userId },
      level: "manage",
    });
    await friend.client.mutation(api.core.libraries.rename, { libraryId, name: " Films " });

    expect((await owner.client.query(api.core.libraries.get, { libraryId })).name).toBe("Films");
    expect(
      await refusal(
        friend.client.mutation(api.core.libraries.setFolders, { libraryId, folders: ["/srv"] }),
      ),
    ).toBe("forbidden");

    await friend.client.mutation(api.core.libraries.remove, { libraryId });

    expect(await sees(owner, libraryId)).toEqual({ get: "not_found", listed: false });
  });

  it("join a scan already queued, and restart a running one when their folders change", async () => {
    if (stack === undefined) return;
    const owner = await person(stack, "owner", "admin");
    const root = await tree(["one/a.flac", "two/b.flac"]);
    const { libraryId, scanJobId } = await create(owner, "music", [join(root, "one")]);

    expect(await owner.client.mutation(api.core.libraries.scan, { libraryId })).toEqual({
      jobId: scanJobId,
      created: false,
    });

    const first = await scanLibrary(stack, "music", libraryId);

    expect(first).toMatchObject({ jobId: scanJobId, outcome: "succeeded", inserted: 1 });

    const rescan = await owner.client.mutation(api.core.libraries.scan, { libraryId });

    expect(rescan.created).toBe(true);

    const calls = scanCalls(stack, "restarted");
    const held = await claimScanOf(calls, "music", libraryId);

    const { scanJobId: restartId } = await owner.client.mutation(api.core.libraries.setFolders, {
      libraryId,
      folders: [join(root, "one"), join(root, "two")],
    });

    expect(restartId).not.toBe(rescan.jobId);
    expect(await calls.upsert(held, "music", [])).toEqual({ outcome: "canceled" });

    const second = await scanLibrary(stack, "music", libraryId);

    expect(second).toMatchObject({ jobId: restartId, outcome: "succeeded", inserted: 1 });
    expect(await owner.client.query(api.core.libraries.get, { libraryId })).toMatchObject({
      items: 2,
      scan: { jobId: restartId, status: "succeeded" },
    });
  });
});
