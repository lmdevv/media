import { describe, expect, it } from "vitest";

import { isSystemFolder } from "./system-folders";

describe("isSystemFolder", () => {
  it("refuses /, which holds the kernel file systems, and folders in them", () => {
    expect(["/", "/proc", "/proc/self/root/srv", "/sys/x", "/dev/shm"].map(isSystemFolder)).toEqual(
      [true, true, true, true, true],
    );
  });

  it("allows other folders, including look-alike names", () => {
    expect(["/music", "/srv/proc", "/processed", "/devices"].map(isSystemFolder)).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });
});
