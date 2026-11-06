import type { QueryState, usePlatformStatus } from "@media/sdk/react";
import { Predicate } from "effect";

import type {
  Approval,
  Me,
  PickerView,
  ServerInfo,
  SharedPicker,
  SharedTile,
  UserId,
} from "./platform-types";

type AuthStatus = ReturnType<typeof usePlatformStatus>;

type QueryError = Extract<QueryState<unknown>, { readonly status: "error" }>["error"];

/**
 * What a page needs before it shows: nothing (`public`), a sign-in of any kind (`anyone`), a
 * session that can change an account (`account`, which a shared-device tile session never has), or
 * an admin.
 */
export type Need = "public" | "anyone" | "account" | "admin";

/** What the route asks for, besides its page. */
export type Intent =
  | { readonly kind: "page"; readonly need: Need }
  /** `/`: who is using this device. */
  | { readonly kind: "picker" }
  /** `/add`: sign someone else in on this browser. */
  | { readonly kind: "add" }
  /** `/tile/$userId`: a locked tile on a shared device. */
  | { readonly kind: "tile"; readonly userId: UserId };

/** A tile on a personal device's picker. */
export interface PersonalTile {
  readonly userId: UserId;
  readonly username: string;
  /** This browser holds the person's session, so the tile opens without a password. */
  readonly here: boolean;
}

/** Everything that decides the screen. */
export interface ScreenInputs {
  readonly intent: Intent;
  readonly server: QueryState<ServerInfo>;
  readonly status: AuthStatus;
  /** Skipped (loading) unless signed in. */
  readonly me: QueryState<Me>;
  /** This browser's device code. */
  readonly device: string | null;
  /** Skipped (loading) without a device code. */
  readonly picker: QueryState<PickerView>;
  /** The people whose session this browser holds. */
  readonly held: ReadonlySet<UserId>;
  /**
   * Whether the client's slot belongs to a person. A sign-in that has not finished registering
   * this browser yet runs on a slot no one holds, and counts as signed out until it does.
   */
  readonly slotHeld: boolean;
}

/** The one screen to show. */
export type Screen =
  | { readonly kind: "loading" }
  | { readonly kind: "unreachable"; readonly retry: () => void }
  | { readonly kind: "setUpOwner" }
  | { readonly kind: "signIn"; readonly adding: boolean }
  | { readonly kind: "personalPicker"; readonly tiles: ReadonlyArray<PersonalTile> }
  | { readonly kind: "sharedPicker"; readonly picker: SharedPicker }
  | {
      readonly kind: "tileLock";
      readonly picker: SharedPicker;
      readonly tile: SharedTile;
      /** The approval this device waits on for this tile, if any. */
      readonly approval: Approval | null;
    }
  /** A shared-device tile session on a page that changes an account. */
  | { readonly kind: "needsAccount"; readonly me: Me }
  | { readonly kind: "needsAdmin"; readonly me: Me }
  | { readonly kind: "page"; readonly me: Me | null };

const LOADING: Screen = { kind: "loading" };

/**
 * The server refused a session the client still holds: the SDK is renewing it, or a tile that
 * opened on this shared device replaced it. Either way the status settles, so the gate waits.
 */
export const isRenewing = (error: QueryError): boolean =>
  Predicate.isTagged(error, "Unauthenticated");

const pageFor = (need: Need, me: Me): Screen => {
  if (need === "admin" && !me.scopes.includes("admin")) {
    return me.scopes.includes("account")
      ? { kind: "needsAdmin", me }
      : { kind: "needsAccount", me };
  }

  if (need === "account" && !me.scopes.includes("account")) return { kind: "needsAccount", me };

  return { kind: "page", me };
};

const personalTiles = (
  picker: Extract<PickerView, { readonly mode: "personal" }>,
  held: ReadonlySet<UserId>,
): ReadonlyArray<PersonalTile> =>
  picker.tiles.map((tile) => ({ ...tile, here: held.has(tile.userId) }));

const signedOutScreen = (inputs: ScreenInputs): Screen => {
  const { intent, picker, device } = inputs;

  if (intent.kind === "add") return { kind: "signIn", adding: inputs.held.size > 0 };

  if (device === null) return { kind: "signIn", adding: false };

  if (picker.status === "loading") return LOADING;

  if (picker.status === "error") {
    return Predicate.isTagged(picker.error, "NotFound")
      ? { kind: "signIn", adding: false }
      : { kind: "unreachable", retry: picker.retry };
  }

  const view = picker.data;

  if (view.mode === "shared")
    return sharedScreen(intent, view) ?? { kind: "sharedPicker", picker: view };

  const tiles = personalTiles(view, inputs.held);

  return tiles.some((tile) => tile.here)
    ? { kind: "personalPicker", tiles }
    : { kind: "signIn", adding: false };
};

/** A shared device's lock screen when the route asks for a locked tile. */
const sharedScreen = (intent: Intent, view: SharedPicker): Screen | null => {
  if (intent.kind !== "tile") return null;

  const tile = view.tiles.find((candidate) => candidate.userId === intent.userId);

  if (tile === undefined || tile.lock.state === "open") return null;

  const approval =
    view.approval !== null &&
    view.approval.intent === "open" &&
    view.approval.userId === intent.userId
      ? view.approval
      : null;

  return { kind: "tileLock", picker: view, tile, approval };
};

/**
 * The screen for `inputs`. Public pages show at once. Otherwise the server must answer, have an
 * owner, and the session must be read. Signed out, a browser with people on it shows its picker
 * and one without shows sign-in. Signed in, `/` shows the picker and pages check the session's
 * scopes. A shared device always shows its own picker, whose tiles open as tile sessions.
 */
export const screenOf = (inputs: ScreenInputs): Screen => {
  const { intent, server, status, me, picker } = inputs;

  if (intent.kind === "page" && intent.need === "public") {
    return { kind: "page", me: me.status === "success" ? me.data : null };
  }

  if (server.status === "loading") return LOADING;

  if (server.status === "error") return { kind: "unreachable", retry: server.retry };

  if (!server.data.hasOwner) return { kind: "setUpOwner" };

  if (status === "loading") return LOADING;

  if (status === "signedOut" || !inputs.slotHeld) return signedOutScreen(inputs);

  if (intent.kind === "add") return { kind: "signIn", adding: true };

  if (me.status === "loading") return LOADING;

  if (me.status === "error") {
    return isRenewing(me.error) ? LOADING : { kind: "unreachable", retry: me.retry };
  }

  if (intent.kind === "page") return pageFor(intent.need, me.data);

  if (picker.status === "loading" && inputs.device !== null) return LOADING;

  if (picker.status === "success") {
    const view = picker.data;

    if (view.mode === "shared") {
      return sharedScreen(intent, view) ?? { kind: "sharedPicker", picker: view };
    }

    return { kind: "personalPicker", tiles: personalTiles(view, inputs.held) };
  }

  return {
    kind: "personalPicker",
    tiles: [{ userId: me.data.userId, username: me.data.username, here: true }],
  };
};

/**
 * Whether the core no longer knows this browser's device, so its code should go. Sessions that
 * ended stay stored until someone signs in on their slot again: a newer sign-in can reach another
 * tab's storage before its picker catches up, so a picker that does not list someone yet is no
 * proof their session ended.
 */
export const deviceUnknown = (inputs: ScreenInputs): boolean =>
  inputs.picker.status === "error" && Predicate.isTagged(inputs.picker.error, "NotFound");
