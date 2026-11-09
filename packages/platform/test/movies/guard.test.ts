import { join } from "node:path";

import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { api } from "../../convex/_generated/api";
import { callFunction } from "../admin";
import { member } from "../devices";
import { runServer, runServerAs } from "../service";
import { refusal, signIn } from "../sign-in";
import { coreStackFromEnvFile } from "../stack-env";
import { Landed, totalsOf } from "./catalog";
import { moviesLibrary } from "./catalog";
import { movieFile } from "./scanned";

const stack = coreStackFromEnvFile();

const Waiting = Schema.Array(Schema.Unknown);

describe.skipIf(stack === undefined)("the media-service guard", { timeout: 120_000 }, () => {
  it("refuses a person's session, an API key without media-service, and no session", async () => {
    if (stack === undefined) return;
    const admin = await member(stack, "guard-admin", "admin");
    const { libraryId, scanJobId, roots } = await moviesLibrary(admin, "Guarded");
    const lease = { jobId: scanJobId, attempt: 1 };
    const items = [movieFile(join(roots[0] ?? "", "a.mkv"))];

    const { key } = await admin.signedIn.client.action(api.core.auth.apiKeys.create, {
      name: "everything a person may hold",
      scopes: ["admin", "movies:read", "movies:play", "movies:edit"],
    });

    const keyed = await signIn(stack, "apiKey", { key });

    const upsertAs = (token: string) =>
      callFunction(
        stack.url,
        `Bearer ${token}`,
        api.movies.scanner.upsert,
        { lease, items },
        Landed,
      );

    expect(await refusal(upsertAs(admin.signedIn.token))).toBe("forbidden");
    expect(await refusal(upsertAs(keyed.token))).toBe("forbidden");
    expect(
      await refusal(
        runServerAs(
          stack,
          keyed,
          api.core.jobs.worker.waiting,
          { kinds: ["movies.scan"] },
          Waiting,
        ),
      ),
    ).toBe("forbidden");
    expect(
      await refusal(
        callFunction(stack.url, "", api.core.jobs.worker.waiting, { kinds: [] }, Waiting),
      ),
    ).toBe("unauthenticated");
    expect(await totalsOf(stack, libraryId)).toEqual({ titles: 0, episodes: 0, files: 0 });
    expect(
      await runServer(stack, api.core.jobs.worker.waiting, { kinds: ["movies.scan"] }, Waiting),
    ).toHaveLength(1);
  });
});
