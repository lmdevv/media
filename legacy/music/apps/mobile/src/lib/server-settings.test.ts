import { describe, expect, it } from "vitest";

import { settingsUpdate } from "./server-settings";

const saved = { jamGuestAccounts: false, remoteLyrics: true };

describe("settingsUpdate", () => {
  it("sends only the setting the person changed", () => {
    expect(settingsUpdate({ jamGuestAccounts: true }, saved)).toEqual({ jamGuestAccounts: true });
    expect(settingsUpdate({ remoteLyrics: false }, saved)).toEqual({ remoteLyrics: false });
  });

  it("leaves a setting changed elsewhere alone when the person did not touch it", () => {
    const elsewhere = { jamGuestAccounts: false, remoteLyrics: false };

    expect(settingsUpdate({ jamGuestAccounts: true }, elsewhere)).toEqual({
      jamGuestAccounts: true,
    });
  });

  it("sends both when the person changed both", () => {
    expect(settingsUpdate({ jamGuestAccounts: true, remoteLyrics: false }, saved)).toEqual({
      jamGuestAccounts: true,
      remoteLyrics: false,
    });
  });

  it("sends nothing when every choice matches what is saved", () => {
    expect(settingsUpdate({}, saved)).toBeNull();
    expect(settingsUpdate({ jamGuestAccounts: false, remoteLyrics: true }, saved)).toBeNull();
  });
});
