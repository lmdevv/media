import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { folderChain, sourceIn } from "./folder-identity.ts";

const MOUNTS = [
  "62 1 259:3 / / rw,relatime shared:1 - ext4 /dev/nvme0n1p1 rw",
  "70 62 0:40 / /mnt/nas rw - nfs nas:/export rw",
  "71 62 259:3 /srv/library/child /srv/alias rw - ext4 /dev/nvme0n1p1 rw",
  "72 62 259:3 /srv/with\\040space /srv/spaced rw - ext4 /dev/nvme0n1p1 rw",
  "73 70 0:41 /films /mnt/nas/films rw - nfs nas:/films rw",
  "74 62 259:3 /first /srv/stacked rw - ext4 /dev/nvme0n1p1 rw",
  "75 62 259:3 /second /srv/stacked rw - ext4 /dev/nvme0n1p1 rw",
].join("\n");

describe("folder sources", () => {
  it("puts a bind mount of a folder's child inside that folder's source", () => {
    expect(sourceIn(MOUNTS, "/srv/library")).toEqual({ device: "259:3", path: "/srv/library" });
    expect(sourceIn(MOUNTS, "/srv/alias")).toEqual({
      device: "259:3",
      path: "/srv/library/child",
    });
    expect(sourceIn(MOUNTS, "/srv/alias/season 1")).toEqual({
      device: "259:3",
      path: "/srv/library/child/season 1",
    });
  });

  it("follows the innermost mount, the last one listed on a point, and escaped names", () => {
    expect(sourceIn(MOUNTS, "/mnt/nas/films/Sintel")).toEqual({
      device: "0:41",
      path: "/films/Sintel",
    });
    expect(sourceIn(MOUNTS, "/mnt/nas/shows")).toEqual({ device: "0:40", path: "/shows" });
    expect(sourceIn(MOUNTS, "/srv/stacked/x")).toEqual({ device: "259:3", path: "/second/x" });
    expect(sourceIn(MOUNTS, "/srv/spaced")).toEqual({ device: "259:3", path: "/srv/with space" });
  });

  it("sends no source for a path too deep to compare within the core's bounds", () => {
    const deep = `/${Array.from({ length: 65 }, (_, n) => `d${String(n)}`).join("/")}`;

    expect(sourceIn(MOUNTS, deep)).toBeNull();
    expect(sourceIn("", "/srv/library")).toBeNull();
  });
});

const namespacesWork = (() => {
  try {
    execFileSync("unshare", ["-rm", "true"], { stdio: "ignore" });

    return true;
  } catch {
    return false;
  }
})();

const moduleUrl = new URL("./folder-identity.ts", import.meta.url).href;

const PRINT = `
  import { folderChain, folderSource } from ${JSON.stringify(moduleUrl)};
  const [library, alias] = process.argv.slice(1);
  const [libraryChain, aliasChain] = [await folderChain(library), await folderChain(alias)];
  const [librarySource, aliasSource] = [await folderSource(library), await folderSource(alias)];
  console.log([libraryChain[0], aliasChain.join(","), librarySource.device, librarySource.path, aliasSource.device, aliasSource.path].join("\\n"));
`;

describe.skipIf(!namespacesWork)("a real bind mount in a user and mount namespace", () => {
  let base = "";

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), "media-folder-identity-"));
    await mkdir(join(base, "library", "child"), { recursive: true });
    await mkdir(join(base, "alias"));
  });

  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("finds a bound child inside its folder by source, where the identity chains never meet", () => {
    const library = join(base, "library");
    const alias = join(base, "alias");

    const printed = execFileSync(
      "unshare",
      [
        "-rm",
        "sh",
        "-c",
        'mount --bind "$1/child" "$2" && exec "$3" --input-type=module -e "$4" "$1" "$2"',
        "sh",
        library,
        alias,
        process.execPath,
        PRINT,
      ],
      { encoding: "utf8" },
    );

    const [libraryOwn = "", aliasChain = "", libraryDevice, libraryPath, aliasDevice, aliasPath] =
      printed.trimEnd().split("\n");

    // The identity chain of the bind mount never reaches the library folder.
    expect(aliasChain.split(",")).not.toContain(libraryOwn);
    // Its source does: the same device, and a path inside the library's.
    expect(aliasDevice).toBe(libraryDevice);
    expect(aliasPath).toBe(`${libraryPath ?? ""}/child`);
  });

  it("reads the same chain for a folder as before", async () => {
    expect((await folderChain(base)).length).toBeGreaterThan(1);
  });
});
