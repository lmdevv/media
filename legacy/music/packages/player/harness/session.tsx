/**
 * Session harness page: the real `PlayerProvider` against the dev backend, with a bare debug view.
 * Open `/?email=…&password=…&tracks=id1,id2` in two browsers to act as two devices of one user.
 */
import { DeviceId, TrackId } from "@music/commands/ids";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { Schema } from "effect";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import type { PlayerEngine } from "../src/engine";
import { HtmlAudioEngine } from "../src/html-audio-engine";
import { PlayerProvider, usePlayer, usePlayerPosition } from "../src/react";
import { harnessAccount, signIn } from "./auth";

const params = new URLSearchParams(location.search);

const convexUrl = Schema.decodeUnknownSync(Schema.String)(import.meta.env["VITE_CONVEX_URL"]);

const email = params.get("email") ?? harnessAccount.email;

const password = params.get("password") ?? harnessAccount.password;

const trackIds = (params.get("tracks") ?? "")
  .split(",")
  .filter((id) => id.length > 0)
  .map((id) => TrackId.make(id));

function Debug() {
  const player = usePlayer();
  const position = usePlayerPosition();
  const [target, setTarget] = useState("");

  useEffect(() => {
    window.player = player;
  }, [player]);

  const rows = [
    ["status", player.status],
    ["track", player.track?.title ?? "none"],
    ["this-device", String(player.isThisDevice)],
    ["active-device", player.activeDevice?.name ?? "none"],
    ["device-id", player.deviceId ?? "none"],
    ["position", String(position)],
    ["media-online", String(player.mediaOnline)],
    ["autoplay-blocked", String(player.autoplayBlocked)],
    ["error", player.error ?? "none"],
  ] as const;

  return (
    <main>
      <dl>
        {rows.map(([name, value]) => (
          <div key={name}>
            <dt>{name}</dt>
            <dd data-testid={name}>{value}</dd>
          </div>
        ))}
      </dl>
      <button type="button" onClick={() => void player.playTracks(trackIds, 0)}>
        Play all
      </button>
      <button type="button" onClick={() => void player.togglePlay()}>
        Toggle
      </button>
      <button type="button" onClick={() => void player.playHere()}>
        Play here
      </button>
      <button type="button" onClick={() => void player.next()}>
        Next
      </button>
      <input
        aria-label="Transfer target"
        value={target}
        onChange={(event) => {
          setTarget(event.target.value);
        }}
      />
      <button
        type="button"
        disabled={target === ""}
        onClick={() => void player.transferTo(DeviceId.make(target))}
      >
        Transfer
      </button>
    </main>
  );
}

const convex = new ConvexReactClient(convexUrl);

const token = await signIn(convexUrl, email, password);

convex.setAuth(() => Promise.resolve(token));

const root = document.querySelector("#root");

/** Records every audio element the engine makes, so tests can see which device outputs sound. */
const audioElements = new Set<HTMLMediaElement>();

window.audioElements = audioElements;

const recordedEngine = (): PlayerEngine =>
  new HtmlAudioEngine(() => {
    const element = new Audio();
    audioElements.add(element);

    return element;
  });

if (root !== null) {
  createRoot(root).render(
    <ConvexProvider client={convex}>
      <PlayerProvider engine={recordedEngine}>
        <Debug />
      </PlayerProvider>
    </ConvexProvider>,
  );
}
