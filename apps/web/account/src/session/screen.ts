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
  /** `/tile/$userId`: a locked tile on a shared device. */
  | { readonly kind: "tile"; readonly userId: UserId };

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
}

/** The one screen to show. */
export type Screen =
  | { readonly kind: "loading" }
  | { readonly kind: "unreachable"; readonly retry: () => void }
  | { readonly kind: "setUpOwner" }
  | { readonly kind: "signIn" }
  /** `/` signed in on a personal device, which goes to the person's home. */
  | { readonly kind: "home" }
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

const SIGN_IN: Screen = { kind: "signIn" };

const signedOutScreen = (inputs: ScreenInputs): Screen => {
  const { intent, picker, device } = inputs;

  if (device === null) return SIGN_IN;

  if (picker.status === "loading") return LOADING;

  if (picker.status === "error") {
    return Predicate.isTagged(picker.error, "NotFound")
      ? SIGN_IN
      : { kind: "unreachable", retry: picker.retry };
  }

  const view = picker.data;

  return view.mode === "shared"
    ? (sharedScreen(intent, view) ?? { kind: "sharedPicker", picker: view })
    : SIGN_IN;
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
 * owner, and the session must be read. Signed out, a shared device shows its picker and any other
 * browser shows sign-in. Signed in, pages check the session's scopes, and `/` shows a shared
 * device's picker, whose tiles open as tile sessions, or goes home on a personal one.
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

  if (status === "signedOut") return signedOutScreen(inputs);

  if (me.status === "loading") return LOADING;

  if (me.status === "error") {
    return isRenewing(me.error) ? LOADING : { kind: "unreachable", retry: me.retry };
  }

  if (intent.kind === "page") return pageFor(intent.need, me.data);

  if (picker.status === "loading" && inputs.device !== null) return LOADING;

  if (picker.status === "success" && picker.data.mode === "shared") {
    return sharedScreen(intent, picker.data) ?? { kind: "sharedPicker", picker: picker.data };
  }

  return { kind: "home" };
};
