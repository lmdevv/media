/**
 * Where the app stands with its server. The root stack shows only the screens of the current
 * phase, so signing in, finishing setup, or signing out moves to the right place by itself.
 */
import { can } from "@music/commands/permissions";
import type { Role } from "@music/commands/models";
import type { SessionEnd } from "@music/sdk/errors";

/** The phases the root stack switches between. */
export type SessionPhase =
  /** No server remembered: Welcome and Connect. */
  | { readonly kind: "disconnected" }
  /** A server is remembered and the app is still hearing from it; the splash stays up. */
  | { readonly kind: "connecting" }
  /** The remembered server has not answered for a while (G05). */
  | { readonly kind: "unreachable" }
  /** The server has people, and this install isn't signed in (E03). */
  | { readonly kind: "signedOut" }
  /** The server ended this install's session because an admin suspended the account (G17). */
  | { readonly kind: "suspended" }
  /** The server has nobody yet: create the owner (E04). */
  | { readonly kind: "needsOwner" }
  /** Signed in as an admin on a server without a library (E05). */
  | { readonly kind: "needsLibrary" }
  /** The first scan of every library is still running (E06). */
  | { readonly kind: "scanning" }
  /** Signed in with music to browse. */
  | { readonly kind: "ready" };

/** The library fields the phase looks at. */
interface LibraryProgress {
  readonly lastScanAt: number | null;
  readonly scanning: boolean;
}

/**
 * This install's own steps through a new server's setup, which the server can't tell apart from
 * someone else's. It lives in memory for one connection.
 */
export type SetupProgress =
  /** Nothing local: the server's state decides. */
  | "none"
  /**
   * The owner account is being created (E04). The server reports its first person before sign-up
   * returns, so without this the phase would leave E04 for Sign in mid-sign-up.
   */
  | "creatingOwner"
  /** The first scan is on screen (E06), and stays there once it ends (E07) or stops (G09). */
  | "followingScan"
  /** Left the first scan screens for Home, even while the scan still runs (G02). */
  | "leftScan";

/** What the phase is derived from; `undefined` means the server has not answered yet. */
export interface PhaseInputs {
  /** Whether this install remembers a server. */
  readonly connected: boolean;
  /** Whether the server has been silent long enough to call it unreachable. */
  readonly silent: boolean;
  readonly auth: "loading" | "signedIn" | "signedOut";
  /** Why the server ended this install's session, once it said; null while nothing ended. */
  readonly ended: SessionEnd | null;
  readonly setup: { readonly hasUsers: boolean; readonly hasLibraries: boolean } | undefined;
  readonly role: Role | undefined;
  readonly libraries: ReadonlyArray<LibraryProgress> | undefined;
  readonly progress: SetupProgress;
}

const waiting = (inputs: PhaseInputs): SessionPhase =>
  inputs.silent ? { kind: "unreachable" } : { kind: "connecting" };

/**
 * The phase for what the server has said so far. A server with nobody on it always asks for the
 * owner, even when an old session is still stored for it.
 */
export const sessionPhase = (inputs: PhaseInputs): SessionPhase => {
  if (!inputs.connected) return { kind: "disconnected" };

  if (inputs.ended === "suspended") return { kind: "suspended" };

  if (inputs.setup === undefined || inputs.auth === "loading") return waiting(inputs);

  const creatingOwner = inputs.progress === "creatingOwner" && inputs.auth === "signedOut";

  if (!inputs.setup.hasUsers || creatingOwner) return { kind: "needsOwner" };

  if (inputs.auth === "signedOut") return { kind: "signedOut" };

  if (inputs.role === undefined || inputs.libraries === undefined) return waiting(inputs);

  if (!inputs.setup.hasLibraries && can(inputs.role, "admin")) return { kind: "needsLibrary" };

  if (inputs.progress === "followingScan") return { kind: "scanning" };

  const firstScan =
    inputs.libraries.some((library) => library.scanning) &&
    inputs.libraries.every((library) => library.lastScanAt === null);

  return firstScan && inputs.progress !== "leftScan" ? { kind: "scanning" } : { kind: "ready" };
};

/** A phase the root stack has screens for. */
export type SettledPhase = Exclude<SessionPhase, { readonly kind: "connecting" }>;

/**
 * `next` when it has screens, else the phase already on screen. A reconnect or a token refresh
 * then keeps the screens, and their navigation, in place instead of falling back to the splash,
 * and losing the server after it answered stays on screen too (G04 reconnects in place); only a
 * server that never answered this launch shows as unreachable.
 */
export const settle = (next: SessionPhase, shown: SettledPhase | null): SettledPhase | null => {
  if (next.kind === "connecting") return shown;

  if (next.kind === "unreachable" && shown !== null && shown.kind !== "disconnected") return shown;

  return next;
};
