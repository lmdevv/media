import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("nixos-module-e2e.sh", import.meta.url));

/** How the stand-in `docker` answers `docker inspect`, call by call; the last answer repeats. */
type InspectAnswer = "unreachable" | "absent" | "present";

interface Run {
  readonly status: number | null;
  readonly stderr: string;
  /** Each call the stand-ins (`docker`, `sudo`, `node`, `nix`) received, in order. */
  readonly commands: ReadonlyArray<string>;
}

const folders: Array<string> = [];

afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const executable = (path: string, body: string): void => {
  writeFileSync(path, `#!/usr/bin/env bash\n${body}`);
  chmodSync(path, 0o755);
};

/**
 * Runs the e2e script with stand-ins that record each call: `docker`, which answers `inspect` as
 * told and fails `create` on the name, `sudo`, which does nothing and succeeds, and `node` and `nix`,
 * which fail, so a run that gets past its checks stops at its first fixture. Nothing reaches the
 * host's Docker, systemd, or files.
 */
const runScript = (answers: ReadonlyArray<InspectAnswer>): Run => {
  const bin = mkdtempSync(join(tmpdir(), "nixos-module-e2e-test-"));
  folders.push(bin);
  const log = join(bin, "commands.log");
  const count = join(bin, "inspect-count");
  writeFileSync(log, "");
  writeFileSync(count, "0");
  executable(
    join(bin, "docker"),
    `echo "docker $*" >> ${JSON.stringify(log)}
answers=(${answers.join(" ")})
case "$1" in
  inspect)
    n=$(cat ${JSON.stringify(count)}); echo $((n + 1)) > ${JSON.stringify(count)}
    answer="\${answers[$n]:-\${answers[-1]}}"
    name="\${*: -1}"
    case "$answer" in
      unreachable) echo "failed to connect to the docker API at unix:///var/run/docker.sock" >&2; exit 1 ;;
      absent) echo "Error: no such object: $name" >&2; exit 1 ;;
      present) echo 4f1c2d3e5a6b; exit 0 ;;
    esac ;;
  create) echo "Error response from daemon: Conflict. The container name is already in use." >&2; exit 125 ;;
  *) exit 0 ;;
esac
`,
  );
  executable(join(bin, "sudo"), `echo "sudo $*" >> ${JSON.stringify(log)}\n`);

  for (const name of ["node", "nix"]) {
    executable(join(bin, name), `echo "${name} $*" >> ${JSON.stringify(log)}\nexit 1\n`);
  }

  const result = spawnSync(script, {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env["PATH"] ?? ""}`, KEEP: "0" },
  });

  return {
    status: result.status,
    stderr: result.stderr,
    commands: readFileSync(log, "utf8")
      .split("\n")
      .filter((line) => line !== ""),
  };
};

const removals = (run: Run): ReadonlyArray<string> =>
  run.commands.filter((command) =>
    /^docker (rm|container rm|volume rm|network rm)\b/.test(command),
  );

describe("nixos-module-e2e.sh", { timeout: 30_000 }, () => {
  it("stops before it arms cleanup when Docker cannot say whether the container exists", () => {
    // Docker is still starting: the first inspect fails, and the host's real container answers by
    // the time the script would make its own.
    const run = runScript(["unreachable", "present"]);

    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain(
      "could not tell whether a container named media-core-convex exists",
    );
    expect(run.commands).toEqual(["docker inspect --format {{.Id}} media-core-convex"]);
  });

  it("refuses a host where the container already exists, and removes nothing", () => {
    const run = runScript(["present"]);

    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("a container named media-core-convex already exists");
    expect(removals(run)).toEqual([]);
  });

  it("removes no container it did not make when a later step fails", () => {
    // On a host with an install of its own, the run stops at the folder checks instead of its first
    // fixture.
    const run = runScript(["absent"]);

    expect(run.status).not.toBe(0);
    expect(run.commands.filter((command) => command.startsWith("docker create"))).toEqual([]);
    expect(removals(run)).toEqual([]);
  });
});
