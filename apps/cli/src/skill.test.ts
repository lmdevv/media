import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const skill = join(import.meta.dirname, "..", "skills", "media");

const byCodeUnits = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

describe("the media skill", () => {
  it("names every reference it ships, and ships every reference it names", async () => {
    const text = await readFile(join(skill, "SKILL.md"), "utf8");
    const named = new Set([...text.matchAll(/`([\w/-]+\.md)`/gu)].map((match) => match[1] ?? ""));

    const shipped = (await readdir(skill, { recursive: true }))
      .filter((path) => path.endsWith(".md") && path !== "SKILL.md")
      .toSorted(byCodeUnits);

    expect([...named].toSorted(byCodeUnits)).toEqual(shipped);
  });
});
