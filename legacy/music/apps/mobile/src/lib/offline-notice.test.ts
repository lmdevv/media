import { describe, expect, it } from "vitest";

import { offlineNotice } from "./offline-notice";

const host = "music.example.com";

describe("offlineNotice", () => {
  it("says nothing while the server answers", () => {
    expect(offlineNotice({ reach: "online", hasDownloads: true, host, playingHere: false })).toBe(
      null,
    );
  });

  it("names the server on a launch that never reached it (D11)", () => {
    expect(
      offlineNotice({ reach: "offline", hasDownloads: true, host, playingHere: false }),
    ).toEqual({
      kind: "offline",
      title: "You’re offline",
      body: "music.example.com is out of reach. Everything you downloaded still plays.",
      label: "Offline",
      retry: true,
    });
  });

  it("hides Try again while music plays here, since reconnecting would stop it", () => {
    expect(
      offlineNotice({ reach: "offline", hasDownloads: true, host, playingHere: true })?.retry,
    ).toBe(false);
  });

  it("promises the downloads keep playing once the server drops (D14)", () => {
    expect(
      offlineNotice({ reach: "reconnecting", hasDownloads: true, host, playingHere: false }),
    ).toEqual({
      kind: "reconnecting",
      title: "Reconnecting to music.example.com",
      body: "Downloads keep playing. Your full library and queue come back when the server answers.",
      label: "Reconnecting",
      retry: false,
    });
  });

  it("keeps G04's words for a phone with nothing downloaded", () => {
    expect(
      offlineNotice({ reach: "reconnecting", hasDownloads: false, host, playingHere: false })?.body,
    ).toBe("Your queue is saved. Changes will be available when you reconnect.");
  });
});
