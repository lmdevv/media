import { describe, expect, it } from "vitest";

import { anyEdited, fieldEdit, overtakenFields, overtakenLine, sameValue } from "./edits";

describe("fieldEdit", () => {
  it("writes nothing for a field the person left alone, whatever the core did meanwhile", () => {
    expect(fieldEdit("/media/old", "/media/old", "/media/new")).toStrictEqual({ kind: "unedited" });
  });

  it("writes a field the person changed, and says when the core changed it too", () => {
    expect(fieldEdit("Movies", "Films", "Movies")).toStrictEqual({
      kind: "edited",
      to: "Films",
      overtaken: false,
    });
    expect(fieldEdit("Movies", "Films", "Cinema")).toStrictEqual({
      kind: "edited",
      to: "Films",
      overtaken: true,
    });
  });

  it("compares lists element by element", () => {
    expect(sameValue(["/a", "/b"], ["/a", "/b"])).toBe(true);
    expect(sameValue(["/a"], ["/a", "/b"])).toBe(false);
    expect(fieldEdit(["/a"], ["/a"], ["/b"]).kind).toBe("unedited");
  });
});

describe("a save", () => {
  it("names the edited fields the core changed meanwhile, and nothing else", () => {
    const fields = {
      Name: fieldEdit("Movies", "Films", "Cinema"),
      Folders: fieldEdit(["/media/old"], ["/media/old"], ["/media/new"]),
    };

    expect(anyEdited([fields.Name, fields.Folders])).toBe(true);
    expect(overtakenFields(fields)).toStrictEqual(["Name"]);
    expect(overtakenLine(["Name"])).toBe("Name changed while you were editing.");
    expect(overtakenLine(["Role", "Movies", "Shows"])).toBe(
      "Role, Movies and Shows changed while you were editing.",
    );
    expect(anyEdited([fields.Folders])).toBe(false);
  });
});
