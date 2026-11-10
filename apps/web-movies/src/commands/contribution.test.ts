import type { CommandItem } from "@media/ui/lib/command-menu";
import { describe, expect, it } from "vitest";

import { mergeContributions } from "./contribution";

const item = (id: string): CommandItem => ({
  kind: "action",
  id,
  title: id,
  perform: () => undefined,
});

describe("mergeContributions", () => {
  it("joins groups that share an id, in contribution order", () => {
    const merged = mergeContributions([
      {
        groups: [
          { id: "go", label: "Go to", items: [item("home")] },
          { id: "actions", label: "Actions", items: [item("theme")] },
        ],
      },
      {
        groups: [{ id: "actions", label: "Ignored", items: [item("scan")] }],
        fallback: [item("search")],
      },
    ]);

    expect(
      merged.groups.map((group) => [group.id, group.label, group.items.map((i) => i.id)]),
    ).toEqual([
      ["go", "Go to", ["home"]],
      ["actions", "Actions", ["theme", "scan"]],
    ]);
    expect(merged.fallback.map((i) => i.id)).toEqual(["search"]);
  });

  it("drops groups left empty", () => {
    expect(mergeContributions([{ groups: [{ id: "titles", items: [] }] }]).groups).toEqual([]);
  });
});
