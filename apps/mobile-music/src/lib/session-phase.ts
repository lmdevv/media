import type { AppRecord } from "@media/mobile-core/records";

import type { Me } from "./models";

/** The phases the root stack switches between. */
export type SessionPhase =
  /** No server remembered: Welcome and Connect. */
  | { readonly kind: "disconnected" }
  /** A server is remembered and the app is still hearing from it; the splash stays up. */
  | { readonly kind: "connecting" }
  /** The remembered server has not answered for a while (G05). */
  | { readonly kind: "unreachable" }
  /**
   * The remembered server has not answered since launch, and this install keeps downloads for the
   * person last signed in to it: the app opens on them (D11).
   */
  | { readonly kind: "offline" }
  /**
   * The server has an owner, and this app is signed out (E03). `person` is who this app last
   * signed in as here: the app then asks for their password again rather than using the phone's
   * grant (D59).
   */
  | { readonly kind: "signedOut"; readonly person: AppRecord["person"] }
  /** The server has no owner yet: create the owner (E04). */
  | { readonly kind: "needsOwner" }
  /** The owner just created here adds a first library (E05). */
  | { readonly kind: "needsLibrary"; readonly me: Me }
  /** The first scan of the library added here is on screen (E06). */
  | { readonly kind: "scanning"; readonly me: Me }
  /** Signed in with music to browse. */
  | { readonly kind: "ready"; readonly me: Me };

/**
 * This install's own steps through a new server's setup, which the server can't tell apart from
 * someone else's. It lives in memory for one connection.
 */
export type SetupProgress =
  /** Nothing local: the server's state decides. */
  | "none"
  /**
   * The owner account is being created (E04). The core reports its owner before the setup
   * sign-in returns, so without this the phase would leave E04 for Sign in mid-sign-up.
   */
  | "creatingOwner"
  /** The owner made here adds the first library (E05). */
  | "addingLibrary"
  /**
   * The first scan of the library added here is on screen (E06), and stays there once it ends
   * (E07) or stops (G09).
   */
  | { readonly kind: "followingScan"; readonly libraryId: string };

/** What the phase is derived from; `undefined` means the server has not answered yet. */
export interface PhaseInputs {
  /** Whether this install remembers a server. */
  readonly connected: boolean;
  /** Whether the server has been silent long enough to call it unreachable. */
  readonly silent: boolean;
  /** Whether this install keeps downloads for the person last signed in to this server. */
  readonly hasDownloads: boolean;
  /** The platform client's session, and whether the launch's silent sign-in is decided (D48). */
  readonly auth: "loading" | "signedIn" | "signedOut";
  readonly launch: "pending" | "done" | "failed";
  /** A sign-in is between its session opening and its device enrolled. */
  readonly signingIn: boolean;
  readonly hasOwner: boolean | undefined;
  readonly me: Me | Error | undefined;
  /** Whether `me`'s failure is the core refusing the session, which the SDK settles itself. */
  readonly refused: boolean;
  /** Who this app last signed in as on this server. */
  readonly person: AppRecord["person"];
  readonly progress: SetupProgress;
}

const waiting = (inputs: PhaseInputs): SessionPhase => {
  if (!inputs.silent) return { kind: "connecting" };

  return inputs.hasDownloads ? { kind: "offline" } : { kind: "unreachable" };
};

/**
 * The phase for what the server has said so far. A server without an owner always asks for the
 * owner, even when an old session is still stored for it.
 */
export const sessionPhase = (inputs: PhaseInputs): SessionPhase => {
  if (!inputs.connected) return { kind: "disconnected" };

  if (inputs.hasOwner === undefined || inputs.auth === "loading") return waiting(inputs);

  const creatingOwner = inputs.progress === "creatingOwner" && inputs.auth === "signedOut";

  if (!inputs.hasOwner || creatingOwner) return { kind: "needsOwner" };

  if (inputs.auth === "signedOut") {
    if (inputs.launch === "pending") return waiting(inputs);

    // The phone's grant could not be exchanged for a reason other than a refusal.
    if (inputs.launch === "failed") return { kind: "unreachable" };

    return { kind: "signedOut", person: inputs.person };
  }

  const { me } = inputs;

  if (inputs.signingIn || me === undefined) return waiting(inputs);

  // The SDK refreshes once on a refusal, then signs out (D51).
  if (me instanceof Error) return inputs.refused ? waiting(inputs) : { kind: "unreachable" };

  const { progress } = inputs;

  if (progress === "none" || progress === "creatingOwner") return { kind: "ready", me };

  return progress === "addingLibrary" ? { kind: "needsLibrary", me } : { kind: "scanning", me };
};

/** A phase the root stack has screens for. */
export type SettledPhase = Exclude<SessionPhase, { readonly kind: "connecting" }>;

const isSilent = (phase: SessionPhase): boolean =>
  phase.kind === "unreachable" || phase.kind === "offline";

/**
 * `next` when it has screens, else the phase already on screen. A reconnect or a token refresh
 * then keeps the screens, and their navigation, in place instead of falling back to the splash,
 * and losing the server after it answered stays on screen too (G04 reconnects in place); only a
 * server that never answered this launch shows as unreachable, or as offline with downloads.
 */
export const settle = (next: SessionPhase, shown: SettledPhase | null): SettledPhase | null => {
  if (next.kind === "connecting") return shown;

  const answered = shown !== null && shown.kind !== "disconnected" && !isSilent(shown);

  const offline = shown?.kind === "offline" && next.kind === "unreachable";

  return (isSilent(next) && answered) || offline ? shown : next;
};

export const sameScreens = (next: SettledPhase, shown: SettledPhase | null): boolean => {
  if (shown === null || next.kind !== shown.kind) return false;

  if (!("me" in next) || !("me" in shown)) return true;

  return next.me.userId === shown.me.userId;
};
