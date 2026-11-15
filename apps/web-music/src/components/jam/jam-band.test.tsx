import { MusicSessionProvider } from "@media/player/session-react";
import type { JoinedSession, MusicSession, SessionView } from "@media/player/session-react";
import { Brand } from "effect";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { UiStateProvider } from "@/components/shell/ui-state";

import { JamBand } from "./jam-band";

type Member = JoinedSession["members"][number];

const sessionId = Brand.nominal<JoinedSession["sessionId"]>()("s1");

const userId = Brand.nominal<Member["userId"]>();

const member = (
  username: string,
  role: Member["role"],
  displayName: string | null = null,
): Member => ({
  userId: userId(username),
  username,
  displayName,
  role,
  present: true,
  linkGuest: false,
});

const joined = (role: JoinedSession["role"]): JoinedSession => ({
  state: "joined",
  sessionId,
  host: "lucia",
  hostDisplayName: "Lucía",
  role,
  link: "mt_s1.secret",
  settings: { join: "open", control: false, add: true },
  may: { control: role === "host", add: true, manage: role === "host" },
  clock: {
    status: "playing",
    positionAtAnchorMs: 0,
    anchorServerTime: 0,
    playbackRate: 1,
    revision: 1,
  },
  item: null,
  entryId: null,
  members: [
    member("lucia", "host", "Lucía"),
    member("aiko", "guest", "Aiko Tanaka"),
    member("mateo", "guest"),
  ],
  pending: role === "host" ? [] : null,
});

/** What the Jam band says for `view`, without tags, spaces folded. */
const band = (view: SessionView): string => {
  const session: MusicSession = {
    view,
    playing: null,
    playingHidden: false,
    entries: [],
    listing: "empty",
    following: null,
    starting: false,
    start: async () => "",
  };

  return renderToStaticMarkup(
    <UiStateProvider>
      <MusicSessionProvider value={session}>
        <JamBand />
      </MusicSessionProvider>
    </UiStateProvider>,
  )
    .replaceAll(/<[^>]+>/gu, " ")
    .replaceAll("&#x27;", "'")
    .replaceAll(/\s+/gu, " ")
    .trim();
};

describe("JamBand", () => {
  it("shows the host their Jam, who is in it, and a way to manage it", () => {
    expect(band(joined("host"))).toBe("Your Jam · 3 people L A M Manage");
  });

  it("shows a member whose Jam it is, and who is in it, by the names they go by", () => {
    expect(band(joined("guest"))).toBe("Lucía's Jam L A M Open");
  });

  it("shows someone waiting to be let in, and that a Jam ended", () => {
    expect(band({ state: "pending", sessionId, host: "lucia", hostDisplayName: null })).toBe(
      "Waiting to join lucia's Jam Open",
    );
    expect(band({ state: "ended", sessionId, reason: "host-left" })).toBe(
      "The Jam ended Back to your music",
    );
  });

  it("shows nothing outside a Jam", () => {
    expect(band(null)).toBe("");
  });
});
