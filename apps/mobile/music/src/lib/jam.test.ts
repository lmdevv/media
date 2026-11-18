import { describe, expect, it } from "vitest";

import { endedLine, jamWebUrl, nameList, parseJamLink } from "./jam";

const LINK = "mt_k57abc123.Sx9-_ZtqLmno0pQrStUvWxYz";

describe("parseJamLink", () => {
  it("reads the link, the web client's address for it, and the app's own", () => {
    expect(parseJamLink(LINK)).toBe(LINK);
    expect(parseJamLink(`https://music.home.test/music/jam#${LINK}`)).toBe(LINK);
    expect(parseJamLink(`music://jam/${LINK}`)).toBe(LINK);
    expect(parseJamLink(`music://jam/${encodeURIComponent(LINK)}/`)).toBe(LINK);
  });

  it("refuses text that holds no Jam link", () => {
    expect(parseJamLink("music://invite/abc")).toBe(null);
    expect(parseJamLink("not a link")).toBe(null);
  });
});

describe("jamWebUrl", () => {
  it("shares the music web client's address on the server, with the link after #", () => {
    expect(jamWebUrl("http://192.168.1.4:8080/", LINK)).toBe(
      `http://192.168.1.4:8080/music/jam#${LINK}`,
    );
  });
});

describe("Jam words", () => {
  it("names people as people say them", () => {
    expect(nameList(["Sam"])).toBe("Sam");
    expect(nameList(["Sam", "Alex"])).toBe("Sam & Alex");
    expect(nameList(["Sam", "Alex", "Riley"])).toBe("Sam, Alex & Riley");
    expect(nameList(["Sam", "Alex", "Riley", "Kai"])).toBe("Sam, Alex & 2 others");
  });

  it("says why a Jam ended", () => {
    expect(endedLine("host-left")).toBe("The host ended it.");
    expect(endedLine("abandoned")).toBe("The host was away for half an hour.");
  });
});
