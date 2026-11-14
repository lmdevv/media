import { Schema } from "effect";
import { afterAll, describe, expect, it } from "vitest";

import { api, internal } from "../../../convex/_generated/api";
import { runFunction } from "../../admin";
import { runServer } from "../../service";
import { createPerson, refusal, signInAs, unique } from "../../sign-in";
import type { SignedIn } from "../../sign-in";
import { coreStackFromEnvFile } from "../../stack-env";
import type { CoreStack } from "../../stack-env";
import { makeTree, removeTree } from "../libraries/files";
import { claimScanOf, scanCalls } from "../libraries/scanner";
import { retrying } from "./driver";
import { listedJob } from "./listed";

const stack = coreStackFromEnvFile();

const roots: Array<string> = [];

afterAll(async () => {
  await Promise.all(roots.map(removeTree));
});

const Settled = Schema.Struct({ outcome: Schema.String });

const Canceled = Schema.Struct({ outcome: Schema.String });

const signedIn = async (
  core: CoreStack,
  label: string,
  role: "admin" | "member",
): Promise<SignedIn["client"]> =>
  (await signInAs(core, await createPerson(core, label, role))).client;

describe.skipIf(stack === undefined)("core.jobs.list", { timeout: 180_000 }, () => {
  it("lists a scan with its attempts to the admins who see its library, its error to managers", async () => {
    if (stack === undefined) return;
    const owner = await signedIn(stack, "jobs-owner", "admin");
    const otherAdmin = await signedIn(stack, "jobs-admin", "admin");
    const member = await signedIn(stack, "jobs-member", "member");
    const folder = await makeTree(["Album/01.flac"]);

    roots.push(folder);

    const { libraryId, scanJobId } = await owner.mutation(api.core.libraries.create, {
      name: `jobs ${unique()}`,
      kind: "music",
      folders: [`${folder}//`],
    });

    // The scan's first attempt fails with a retry, as a worker reports a passing fault.
    const lease = await claimScanOf(scanCalls(stack, `jobs-list-${unique()}`), "music", libraryId);

    await retrying(() =>
      runServer(
        stack,
        api.core.jobs.worker.finish,
        { lease, end: { outcome: "failed", error: "The folder went away", retry: true } },
        Settled,
      ),
    );

    try {
      expect(await listedJob(owner, scanJobId)).toMatchObject({
        kind: "music.scan",
        status: "queued",
        attempts: 1,
        library: { libraryId, level: "manage" },
        error: "The folder went away",
      });

      expect(await listedJob(owner, scanJobId, "queued")).toBeDefined();
      expect(await listedJob(owner, scanJobId, "failed")).toBeUndefined();

      // A library is private to whoever made it until it is shared, admins included.
      expect(await listedJob(otherAdmin, scanJobId)).toBeUndefined();

      await owner.mutation(api.core.permissions.grants.set, {
        resource: { type: "library", id: libraryId },
        principal: { kind: "household" },
        level: "view",
      });

      expect(await listedJob(otherAdmin, scanJobId)).toMatchObject({
        library: { libraryId, level: "view" },
        attempts: 1,
        error: null,
      });

      expect(
        await refusal(
          member.query(api.core.jobs.list, { paginationOpts: { numItems: 10, cursor: null } }),
        ),
      ).toBe("forbidden");
    } finally {
      await runFunction(stack, internal.core.jobs.admin.cancel, { jobId: scanJobId }, Canceled);
    }
  });
});
