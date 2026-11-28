import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("check-path-case.sh", import.meta.url));

const check = (paths: ReadonlyArray<string>) =>
  spawnSync(script, ["-"], { input: paths.map((path) => `${path}\0`).join(""), encoding: "utf8" });

describe("check-path-case.sh", () => {
  it.each([
    {
      kind: "file names",
      paths: ["docs/Guide.md", "docs/guide.md"],
      group: '"docs/Guide.md", "docs/guide.md"',
    },
    {
      kind: "folders",
      paths: ["apps/Mobile/music.ts", "apps/mobile/movies.ts"],
      group: '"apps/Mobile", "apps/mobile"',
    },
    {
      kind: "ancestors several levels up",
      paths: ["apps/mobile/Music/library/src/index.ts", "apps/mobile/music/player/views/main.ts"],
      group: '"apps/mobile/Music", "apps/mobile/music"',
    },
    {
      kind: "a file and a folder",
      paths: ["docs/Guide", "docs/guide/index.md"],
      group: '"docs/Guide", "docs/guide"',
    },
    {
      kind: "names with spaces",
      paths: ["docs/Quick Start.md", "docs/quick start.md"],
      group: '"docs/Quick Start.md", "docs/quick start.md"',
    },
    {
      kind: "names with newlines",
      paths: ["docs/Line\nBreak.md", "docs/line\nbreak.md"],
      group: '"docs/Line\\nBreak.md", "docs/line\\nbreak.md"',
    },
  ])("reports collisions between $kind", ({ paths, group }) => {
    const { status, stdout, stderr } = check(paths);

    expect({ status, stdout, stderr }).toEqual({
      status: 1,
      stdout: `check-path-case: ${group}\n`,
      stderr: "",
    });
  });

  it("prints each group once with every spelling", () => {
    const { status, stdout, stderr } = check(["Guide", "guide", "GUIDE", "Readme", "README"]);

    expect(status).toBe(1);
    expect(stderr).toBe("");
    expect(stdout.trimEnd().split("\n").toSorted()).toEqual([
      'check-path-case: "GUIDE", "Guide", "guide"',
      'check-path-case: "README", "Readme"',
    ]);
  });

  it.each([
    {
      kind: "distinct names",
      paths: ["docs/Guide.md", "docs/Quick Start.md", "examples/guide.md", "docs/Guide.md"],
    },
    { kind: "an empty list", paths: [] },
  ])("passes silently for $kind", ({ paths }) => {
    const { status, stdout, stderr } = check(paths);

    expect({ status, stdout, stderr }).toEqual({ status: 0, stdout: "", stderr: "" });
  });

  it.each([
    {
      kind: "UTF-8",
      input: Buffer.from("docs/café/guide.md\0"),
      prefix: '"docs/caf\\u00c3\\u00a9"',
    },
    { kind: "invalid UTF-8", input: Buffer.from([0xff, 0]), prefix: '"\\u00ff"' },
  ])("rejects non-ASCII bytes in $kind", ({ input, prefix }) => {
    const { status, stdout, stderr } = spawnSync(script, ["-"], { input, encoding: "utf8" });

    expect({ status, stdout, stderr }).toEqual({
      status: 1,
      stdout: "",
      stderr: `check-path-case: ${prefix} contains non-ASCII bytes\n`,
    });
  });

  it("passes silently for the repository index", () => {
    const { status, stdout, stderr } = spawnSync(script, [], { encoding: "utf8" });

    expect({ status, stdout, stderr }).toEqual({ status: 0, stdout: "", stderr: "" });
  });
});
