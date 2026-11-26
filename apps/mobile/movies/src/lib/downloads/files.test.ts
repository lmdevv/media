import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  STORE_FILE,
  UNREADABLE_STORE_FILE,
  accountFolder,
  itemFolder,
  nextOf,
  removalFolder,
  removalNamed,
  subtitleFile,
  videoFile,
} from "./files";

describe("download files", () => {
  it("names folders and files from IDs only, as safe path segments", () => {
    expect(accountFolder("http://192.168.1.20:8080/", "user|1")).toBe(
      "downloads/192.168.1.20_8080/user_1",
    );
    expect(accountFolder("https://movies.example.com/media", "u1")).toBe(
      "downloads/movies.example.com_media/u1",
    );
    expect(itemFolder("p1-t1-../e1")).toBe("p1-t1-.._e1");
    expect(videoFile("mov")).toBe("video.mov");
    expect(subtitleFile("x1a2b/../c")).toBe("subtitle-x1a2b_.._c.vtt");
  });

  it("names a removal's folder so the download's ID and the stamp come back from it whole", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), fc.nat(), (id, stamp) => {
        const folder = removalFolder(id, stamp);

        expect(removalNamed(folder)).toStrictEqual({ id, stamp });
        expect(folder).not.toContain("/");
      }),
    );
  });

  it("never takes a download's folder or the index for a removal", () => {
    fc.assert(
      fc.property(fc.string(), (id) => {
        expect(removalNamed(itemFolder(id))).toBeNull();
      }),
    );

    for (const name of [STORE_FILE, nextOf(STORE_FILE), UNREADABLE_STORE_FILE, "removal+1+%E0"]) {
      expect(removalNamed(name)).toBeNull();
    }
  });
});
