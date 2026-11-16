import { describe, expect, it } from "vitest";

import { castCapableBrowser } from "./cast-sdk";

const CHROME =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

/** User agents that cast with the SDK. */
const CASTING = [
  CHROME,
  `${CHROME} Edg/141.0.0.0`,
  "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36",
];

/** User agents that do not: Safari, Chrome on iOS (WebKit), and Firefox. */
const NOT_CASTING = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.0.0 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (X11; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0",
];

describe("castCapableBrowser", () => {
  it("loads the Cast SDK in Chromium browsers only", () => {
    expect(CASTING.map(castCapableBrowser)).toStrictEqual([true, true, true]);
    expect(NOT_CASTING.map(castCapableBrowser)).toStrictEqual([false, false, false]);
  });
});
