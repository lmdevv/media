import { describe, expect, it } from "vitest";

import { startsWith } from "./start-with";

describe("startsWith", () => {
  it("names what each choice puts in the new playlist", () => {
    expect(startsWith("selection", 3, 12)).toBe("Starts with 3 selected songs");
    expect(startsWith("selection", 1, 12)).toBe("Starts with 1 selected song");
    expect(startsWith("nothing", 3, 12)).toBe("Starts empty");
    expect(startsWith("queue", 3, 12)).toBe("Starts with the current queue, 12 songs");
    expect(startsWith("liked", 3, 12)).toBe("Starts with your liked songs");
  });
});
