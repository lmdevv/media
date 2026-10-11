/**
 * Regenerates the command reference in `skills/music/SKILL.md` from the registry, between the
 * `BEGIN:commands` and `END:commands` markers. Run with `pnpm --filter @music/cli skill:reference`.
 */
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");

const skill = join(root, "..", "..", "skills", "music", "SKILL.md");

const begin = "<!-- BEGIN:commands -->";

const end = "<!-- END:commands -->";

execFileSync(process.execPath, [join(root, "scripts", "build.ts")]);

const reference = execFileSync(
  process.execPath,
  [join(root, "dist", "music.js"), "commands", "--markdown"],
  {
    encoding: "utf8",
  },
).trimEnd();

const text = await readFile(skill, "utf8");

const start = text.indexOf(begin);

const stop = text.indexOf(end);

if (start === -1 || stop < start)
  throw new Error(`${skill} is missing the ${begin} and ${end} markers`);

// The blank line before the end marker matches what oxfmt writes, so formatting never drifts.
await writeFile(
  skill,
  `${text.slice(0, start + begin.length)}\n${reference}\n\n${text.slice(stop)}`,
);
