import { join } from "node:path";

import { Effect, Exit, Option, Redacted, Schema, Scope } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { fileInfo, writeText } from "../testing/stack-processes.ts";
import {
  core,
  eventually,
  issueServiceKey,
  personIn,
  startCoreServer,
} from "../testing/core-stack.ts";
import type { CoreServer, Person } from "../testing/core-stack.ts";
import { makeWorkDir, removeDir } from "../testing/core-host.ts";

const platformRoot = join(import.meta.dirname, "..", "..", "..", "..", "packages", "platform");

const EXPIRED = "movies-nightly-2020-01-01T03-00-00-000Z.zip";

const PARTIAL = ".partial-movies-manual-2020-01-02T03-00-00-000Z.zip";

let scope: Scope.Closeable;

let workDir = "";

let backupDir = "";

let admin: Person;

let member: Person;

let server: CoreServer;

let serviceKey: Redacted.Redacted;

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);

interface Listed {
  readonly id: string;
  readonly fileName: string;
  readonly sizeBytes: number;
  readonly trigger: "nightly" | "manual";
}

const listBackups = async (person: Person): Promise<ReadonlyArray<Listed>> =>
  (
    await run(
      person.platform.core.server.backups.list({
        paginationOpts: { numItems: 50, cursor: null },
      }),
    )
  ).page;

const backUp = async (person: Person): Promise<Listed> => {
  const before = new Set((await listBackups(person)).map((backup) => backup.fileName));

  await run(person.platform.core.server.backups.run({}));

  return eventually(
    "the backup job records a new archive",
    async () => {
      const added = (await listBackups(person)).find((backup) => !before.has(backup.fileName));

      return Option.fromNullishOr(added);
    },
    120_000,
  );
};

const restore = async (person: Person, backupId: string) => {
  const token = await run(person.platform.session.accessToken);

  return fetch(`${server.baseUrl}/api/backups/restore`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...Option.match(token, {
        onNone: () => ({}),
        onSome: (value) => ({ authorization: `Bearer ${Redacted.value(value)}` }),
      }),
    },
    body: JSON.stringify({ backupId }),
  });
};

const Failure = Schema.Struct({ code: Schema.String, message: Schema.String });

describe.skipIf(core === undefined)(
  "backups and restores of the core",
  { timeout: 180_000 },
  () => {
    beforeAll(async () => {
      scope = await run(Scope.make());
      workDir = await makeWorkDir("media-core-backup-");
      backupDir = await makeWorkDir("media-core-backups-");
      await writeText(join(backupDir, EXPIRED), "an expired archive");
      await writeText(join(backupDir, PARTIAL), "a partial export");
      admin = await personIn(scope, "admin");
      member = await personIn(scope, "member");
      serviceKey = await issueServiceKey();

      server = await startCoreServer(scope, {
        serviceKey,
        libraryRoot: join(workDir, "library"),
        workDir: join(workDir, "server"),
        env: {
          BACKUP_DIR: backupDir,
          CONVEX_URL: core?.url ?? "",
          CONVEX_SELF_HOSTED_ADMIN_KEY: core?.adminKey ?? "",
          CONVEX_BACKEND_DIR: platformRoot,
        },
      });
    }, 180_000);

    afterAll(async () => {
      await run(Scope.close(scope, Exit.void));
      await removeDir(workDir);
      await removeDir(backupDir);
    }, 60_000);

    it("lists archives found in the folder at startup", async () => {
      await eventually("the startup sync lists the expired archive", async () =>
        (await listBackups(admin)).some((backup) => backup.fileName === EXPIRED)
          ? Option.some(true)
          : Option.none(),
      );
    });

    it("backs up into a private archive, records it, and prunes past the retention", async () => {
      const taken = await backUp(admin);

      expect(taken.fileName).toMatch(/^media-manual-.*\.zip$/u);
      expect(taken.trigger).toBe("manual");

      await eventually("the prune drops the expired archive", async () =>
        (await listBackups(admin)).every((backup) => backup.fileName !== EXPIRED)
          ? Option.some(true)
          : Option.none(),
      );

      expect(await fileInfo(join(backupDir, taken.fileName))).toEqual({
        size: taken.sizeBytes,
        mode: 0o600,
      });
      expect((await fileInfo(backupDir))?.mode).toBe(0o700);
      expect(await fileInfo(join(backupDir, EXPIRED))).toBeUndefined();
      expect(await fileInfo(join(backupDir, PARTIAL))).toBeUndefined();
    });

    it("refuses a restore to a member and to a request with no session", async () => {
      const [taken] = await listBackups(admin);
      const backupId = taken?.id ?? expect.unreachable();

      const refused = await restore(member, backupId);

      const anonymous = await fetch(`${server.baseUrl}/api/backups/restore`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ backupId }),
      });

      expect(refused.status).toBe(403);
      expect(Schema.decodeUnknownSync(Failure)(await refused.json()).code).toBe("forbidden");
      expect(anonymous.status).toBe(401);
    });

    it("restores the archive, ends every session, and signs the server in again", async () => {
      const [taken] = await listBackups(admin);
      const backupId = taken?.id ?? expect.unreachable();
      const late = await personIn(scope, "member", "late");

      const restored = await restore(admin, backupId);

      expect(restored.status, await restored.clone().text()).toBe(200);

      // Every session from before the import ends, the one of an account made after the backup
      // included. The core ends them 100 a call in scheduled calls, so a stack holding many
      // sessions reaches these two a little after the restore answers.
      await eventually("the admin's session to end", async () =>
        Exit.isFailure(await run(Effect.exit(admin.platform.core.auth.sessions.current())))
          ? Option.some(true)
          : Option.none(),
      );

      await eventually("the late member's session to end", async () =>
        Exit.isFailure(await run(Effect.exit(late.platform.core.auth.sessions.current())))
          ? Option.some(true)
          : Option.none(),
      );

      // The server's key is in the archive, so its next claim signs it in again and runs a job.

      const again = await personIn(scope, "admin", "after");
      const next = await backUp(again);

      expect(next.trigger).toBe("manual");
      expect(server.logged().join("\n")).not.toContain(Redacted.value(serviceKey));
      expect(server.logged().join("\n")).not.toContain(core?.adminKey ?? "-");
    });

    it("refuses a backup whose archive is gone", async () => {
      const someone = await personIn(scope, "admin", "remover");
      const [newest] = await listBackups(someone);
      const gone = newest ?? expect.unreachable();

      await removeDir(join(backupDir, gone.fileName));

      const refused = await restore(someone, gone.id);

      expect(refused.status).toBe(404);
    });
  },
);
