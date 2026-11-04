import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { refusalMessage } from "../src/check.ts";
import { query } from "../src/command.ts";
import { drift, plan, write } from "../src/outputs.ts";
import type { Planned } from "../src/outputs.ts";
import oxfmtConfig from "../../../.oxfmtrc.json" with { type: "json" };
import { platformTarget } from "../src/targets/platform.ts";
import { sdkTarget } from "../src/targets/sdk.ts";
import { skillTarget } from "../src/targets/skill.ts";
import { fixtures } from "./fixtures.ts";

const targets = [
  platformTarget("platform/commands"),
  sdkTarget("sdk/generated"),
  skillTarget("skill/references"),
];

const repos: Array<string> = [];

const freshRepo = async (): Promise<string> => {
  const repo = await mkdtemp(join(tmpdir(), "media-commands-"));

  repos.push(repo);

  return repo;
};

afterEach(async () => {
  await Promise.all(repos.splice(0).map(async (repo) => rm(repo, { recursive: true })));
});

const written = async (
  repo: string,
  planned: Planned,
): Promise<{
  readonly written: ReadonlyArray<string>;
  readonly deleted: ReadonlyArray<string>;
}> => {
  const report = await write(repo, planned);

  if (!report.ok) throw new Error(`foreign files: ${report.foreign.join(", ")}`);

  return report;
};

const planOf = async (declarations: Parameters<typeof plan>[0]): Promise<Planned> => {
  const planned = await plan(declarations, targets);

  if (!planned.ok) throw new Error(planned.refusals.map(refusalMessage).join("\n"));

  return planned.planned;
};

describe("generate", () => {
  it("writes each output of the fixture list as committed", async () => {
    const planned = await planOf(fixtures);

    expect(planned.files.map((file) => file.path)).toEqual([
      "platform/commands/access.ts",
      "platform/commands/core/server.ts",
      "platform/commands/music/playlists.ts",
      "platform/commands/refs.ts",
      "platform/commands/scopes.ts",
      "sdk/generated/commands.ts",
      "skill/references/core.md",
      "skill/references/music.md",
    ]);

    await Promise.all(
      planned.files.map(async (file) =>
        expect(file.text).toMatchFileSnapshot(`./snapshots/${file.path}.snap`),
      ),
    );
  });

  it("orders outputs by code unit and keeps each module's alias distinct", async () => {
    const [info] = fixtures;

    const planned = await planOf(
      (["core.ab.x", "core.aZ.x", "core.fooBar.x", "core.foo.bar.y"] as const).map((name) =>
        query(name, info),
      ),
    );

    const refs = planned.files.find((file) => file.path === "platform/commands/refs.ts");

    expect(refs?.text.match(/Refs as \w+/gu)).toEqual([
      "Refs as core_aZ",
      "Refs as core_ab",
      "Refs as core_foo_bar",
      "Refs as core_fooBar",
    ]);
  });

  it("gives a new command its SDK descriptor at its name's path after one run", async () => {
    const repo = await freshRepo();
    const [info] = fixtures;

    await written(repo, await planOf(fixtures));

    const report = await written(
      repo,
      await planOf([...fixtures, query("core.server.health", { ...info, summary: "Show uptime" })]),
    );

    expect(report.written).toContain("sdk/generated/commands.ts");
    expect(await readFile(join(repo, "sdk/generated/commands.ts"), "utf8")).toContain(
      [
        "const core_server_health = query({",
        '  name: "core.server.health",',
        '  path: "core/server:health",',
      ].join("\n"),
    );
    expect(await readFile(join(repo, "sdk/generated/commands.ts"), "utf8")).toContain(
      [
        "    server: {",
        "      /** `core.server.health` (query, public): Show uptime. */",
        "      health: method.query(core_server_health),",
      ].join("\n"),
    );
  });

  it("writes nothing on a second run", async () => {
    const repo = await freshRepo();
    const planned = await planOf(fixtures);

    const first = await written(repo, planned);
    const second = await written(repo, planned);

    expect(first.written).toHaveLength(planned.files.length);
    expect(second).toEqual({ ok: true, written: [], deleted: [] });
  });

  it("writes nothing when any declaration is refused", async () => {
    const { scope: _, ...unscoped } = query("core.server.health", {
      summary: "Show whether this server is up",
      scope: "public",
      args: {},
      result: fixtures[0].result,
    });

    const planned = await plan([...fixtures, unscoped], targets);

    expect(planned.ok).toBe(false);
  });

  it("finds an edited declaration, a hand edit, a deleted file, and a leftover", async () => {
    const repo = await freshRepo();

    await written(repo, await planOf(fixtures));
    await writeFile(
      join(repo, "platform/commands/scopes.ts"),
      "export type CallerScope = string;\n",
    );
    await rm(join(repo, "skill/references/core.md"));

    const [info, rename] = fixtures;
    const edited = await planOf([{ ...info, summary: "Show the server's name" }, rename]);

    expect(await drift(repo, edited)).toEqual([
      { kind: "stale", path: "platform/commands/core/server.ts" },
      { kind: "extra", path: "platform/commands/music/playlists.ts" },
      { kind: "stale", path: "platform/commands/refs.ts" },
      { kind: "stale", path: "platform/commands/scopes.ts" },
      { kind: "stale", path: "sdk/generated/commands.ts" },
      { kind: "missing", path: "skill/references/core.md" },
      { kind: "extra", path: "skill/references/music.md" },
    ]);

    const report = await written(repo, edited);

    expect(report.deleted).toEqual([
      "platform/commands/music/playlists.ts",
      "skill/references/music.md",
    ]);
    expect(await drift(repo, edited)).toEqual([]);
    expect(await readFile(join(repo, "skill/references/core.md"), "utf8")).toContain(
      "Show the server's name.",
    );
  });

  it("deletes no file it did not write, and writes nothing while one sits in its folder", async () => {
    const repo = await freshRepo();
    const planned = await planOf(fixtures);
    const notes = join(repo, "platform/commands/notes.md");

    await written(repo, planned);
    await writeFile(notes, "# Notes kept by hand\n");
    await rm(join(repo, "skill/references/core.md"));

    expect(await drift(repo, planned)).toEqual([
      { kind: "foreign", path: "platform/commands/notes.md" },
      { kind: "missing", path: "skill/references/core.md" },
    ]);
    expect(await write(repo, planned)).toEqual({
      ok: false,
      foreign: ["platform/commands/notes.md"],
    });
    expect(await readFile(notes, "utf8")).toBe("# Notes kept by hand\n");
    expect(await drift(repo, planned)).toContainEqual({
      kind: "missing",
      path: "skill/references/core.md",
    });
  });

  it("refuses an output folder inside another output's folder", async () => {
    await expect(
      plan(fixtures, [platformTarget("out"), skillTarget("out/references")]),
    ).rejects.toThrow("An output folder holds another output's folder: out/references");
  });

  it("formats as pnpm fmt does, because the repo's oxfmt config sets no format option", () => {
    expect(Object.keys(oxfmtConfig).toSorted()).toEqual(["$schema", "ignorePatterns"]);
  });
});
