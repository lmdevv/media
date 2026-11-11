import { describe, expect, it } from "vitest";

import { accountFolder, itemFolder, subtitleFile, videoFile } from "./files";

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
});
