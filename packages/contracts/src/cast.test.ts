import { describe, expect, it } from "vitest";

import {
  castMusicContentType,
  castMusicProfile,
  isReceiverCredential,
  localOnly,
  streamedTrack,
  withReceiverCredential,
} from "./cast";

const CREDENTIAL = `r1.${"A".repeat(42)}w`;

describe("castMusicProfile", () => {
  it("casts what every Chromecast decodes as it is, and transcodes the rest to AAC", () => {
    expect(castMusicProfile("MPEG 1 Layer 3")).toBe("original");
    expect(castMusicProfile("MPEG-4/AAC")).toBe("original");
    expect(castMusicProfile("FLAC")).toBe("aac-320");
    expect(castMusicProfile("ALAC")).toBe("aac-320");
    expect(castMusicProfile("Opus")).toBe("aac-320");
    expect(castMusicProfile("")).toBe("aac-320");
  });

  it("tells the receiver what each stream holds", () => {
    expect(castMusicContentType("original", "MPEG 1 Layer 3")).toBe("audio/mpeg");
    expect(castMusicContentType("original", "MPEG-4/AAC")).toBe("audio/mp4");
    expect(castMusicContentType("aac-320", "FLAC")).toBe("audio/mp4");
  });
});

describe("receiver credentials", () => {
  it("knows a credential's shape, which no ticket has", () => {
    expect(isReceiverCredential(CREDENTIAL)).toBe(true);
    expect(isReceiverCredential(`${CREDENTIAL}x`)).toBe(false);
    // A ticket's shape, built from its parts: `t1.<kid>.<aud>.<iat>.<exp>.…`.
    const ticket = ["t1", "k1", "media", "3600", "7200", "play", "file", "f1", "s", "u1", "s1"];

    expect(isReceiverCredential([...ticket, "mac"].join("."))).toBe(false);
  });

  it("puts the credential where the ticket was and keeps every other parameter", () => {
    expect(
      withReceiverCredential(
        "http://nas.lan:8080/media/music/stream/song1?ticket=t1.k1.x&p=aac-320",
        CREDENTIAL,
      ),
    ).toBe(`http://nas.lan:8080/media/music/stream/song1?ticket=${CREDENTIAL}&p=aac-320`);
    expect(withReceiverCredential("http://nas.lan:8080/art/a1.png", CREDENTIAL)).toBe(
      "http://nas.lan:8080/art/a1.png",
    );
    expect(withReceiverCredential("not a url", CREDENTIAL)).toBe("not a url");
  });

  it("reads the song a music stream URL plays", () => {
    expect(streamedTrack("http://nas.lan/media/music/stream/song%201?ticket=x")).toBe("song 1");
    expect(streamedTrack("http://nas.lan/media/direct/f1?ticket=x")).toBeNull();
    expect(streamedTrack("http://nas.lan/media/music/stream/%E0%A4%A?ticket=x")).toBeNull();
  });
});

describe("localOnly", () => {
  it("knows addresses a Chromecast on the network cannot reach", () => {
    expect(localOnly("http://localhost:8080")).toBe(true);
    expect(localOnly("http://127.0.0.1:13242")).toBe(true);
    expect(localOnly("http://[::1]:8080")).toBe(true);
    expect(localOnly("http://movies.localhost")).toBe(true);
    expect(localOnly("http://0.0.0.0:4300")).toBe(true);
    expect(localOnly("http://[::]:4300")).toBe(true);
    expect(localOnly("http://[::ffff:127.0.0.1]:4300")).toBe(true);
    expect(localOnly("http://[::ffff:0.0.0.0]:4300")).toBe(true);
    expect(localOnly("http://[::ffff:192.168.1.20]:8080")).toBe(false);
    expect(localOnly("http://192.168.1.20:8080")).toBe(false);
    expect(localOnly("https://nas.tailnet.ts.net")).toBe(false);
  });
});
