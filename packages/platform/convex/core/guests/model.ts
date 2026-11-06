import { v } from "convex/values";
import type { Infer } from "convex/values";

import { domainItem } from "../../../commands/access";
import { contentDomain } from "../../../commands/scopes";
import type { Doc, Id } from "../../_generated/dataModel";
import type { DatabaseReader } from "../../_generated/server";
import { fail } from "../lib/errors";

/** A share link is `mg_<linkId>.<secret>`; the secret is stored as SHA-256 and shown once. */
export const LINK_PREFIX = "mg";

/** Random bytes in a link's secret. */
export const LINK_SECRET_BYTES = 32;

/**
 * Where a share link opens under the guest address. The code rides in the fragment, which no
 * browser sends, so no request line, proxy, or server log ever holds it.
 */
export const LINK_PATH = "/guest#";

/** How long a link lasts when its maker does not say. */
export const DEFAULT_DAYS = 7;

/** The longest a link can last. */
export const DAYS_MAX = 30;

/** Guests one link can ever let in, so a leaked link makes at most this many. */
export const GUESTS_PER_LINK_MAX = 50;

/** Guests one link lets in per hour. */
export const OPENS_PER_LINK_PER_HOUR = 30;

/** Links one person makes per hour. */
export const LINKS_PER_HOUR = 30;

/** The longest display name a guest may give, in code points. */
export const NAME_MAX = 32;

/**
 * What a link names, as stored. A group session is the one its maker hosted when they made the
 * link, by id, so the link never follows them into another session.
 */
export const storedTarget = v.union(
  v.object({ kind: v.literal("item"), item: domainItem }),
  v.object({
    kind: v.literal("session"),
    sessionId: v.id("togetherSessions"),
    domain: contentDomain,
  }),
);

/** What a link names, as stored. */
export type StoredTarget = Infer<typeof storedTarget>;

/**
 * What a maker asks a link for, and what its maker and its guests are shown: an item, or the group
 * session its maker hosts in a domain. The same shape as `shareTarget` in the command list.
 */
export const shareTarget = v.union(
  v.object({ kind: v.literal("item"), item: domainItem }),
  v.object({ kind: v.literal("session"), domain: contentDomain }),
);

/** What a maker asks a link for. */
export type ShareTarget = Infer<typeof shareTarget>;

/** A stored target as its maker and its guests are shown it: a session by its domain alone. */
export const shownTarget = (target: StoredTarget): ShareTarget =>
  target.kind === "item" ? target : { kind: "session", domain: target.domain };

/**
 * One share link (ADR 0007). After it is made only a revoke writes it, so a guest's live check,
 * which reads it on every call, reruns on nothing else.
 */
export const linkDocument = v.object({
  /** SHA-256 of the secret half of the code, hex. */
  secretHash: v.string(),
  maker: v.id("users"),
  /**
   * The maker's `sessionGeneration` when they made it. Losing the right to make links ends the
   * maker's sessions, so the link stays dead even if the right comes back (ADR 0005).
   */
  makerGeneration: v.number(),
  /** The switch's `epoch` when it was made; turning guest links off ends it for good. */
  switchEpoch: v.number(),
  target: storedTarget,
  expiresAt: v.number(),
  revokedAt: v.union(v.number(), v.null()),
});

/** A share link's row. */
export type LinkDoc = Doc<"shareLinks">;

/**
 * The admin-wide switch and the guest address, at most one row. No row reads as off. Turning guest
 * links off bumps `epoch`, so turning them on again revives no link.
 */
export const guestAccessDocument = v.object({
  enabled: v.boolean(),
  epoch: v.number(),
  /** An origin such as `https://media.tail1234.ts.net`, or null before an admin sets one. */
  address: v.union(v.string(), v.null()),
});

/** The switch and the guest address as they stand. */
export interface GuestAccess {
  readonly enabled: boolean;
  readonly epoch: number;
  readonly address: string | null;
}

const OFF: GuestAccess = { enabled: false, epoch: 0, address: null };

/** The switch row, or off when there is none. */
export const guestAccessOf = async (db: DatabaseReader): Promise<GuestAccess> =>
  (await db.query("guestAccess").first()) ?? OFF;

/** Whether guest links are on and `link` was made since they last were. */
export const switchedOnFor = (access: GuestAccess, link: LinkDoc): boolean =>
  access.enabled && access.epoch === link.switchEpoch;

/** A guest's usernameKey: outside the username grammar, so no sign-in lookup ever finds it. */
export const guestKeyOf = (linkId: Id<"shareLinks">, guestNumber: number): string =>
  `~${linkId}.${guestNumber}`;

/** Below every guest's usernameKey and above every household one. */
export const GUEST_KEYS_FROM = "~";

const UNPRINTABLE = /[\p{C}\p{Zl}\p{Zp}]/u;

/** A display name as a guest typed it: trimmed, 1 to `NAME_MAX` code points, all printable. */
export const requireGuestName = (typed: string): string => {
  const name = typed.normalize("NFKC").trim();
  const length = Array.from(name).length;

  return length >= 1 && length <= NAME_MAX && !UNPRINTABLE.test(name)
    ? name
    : fail("invalid_args", `Give a name of 1 to ${NAME_MAX} printable characters`);
};

const urlOf = (text: string): URL | null => {
  try {
    return new URL(text);
  } catch {
    return null;
  }
};

const refuseAddress = (): never =>
  fail("invalid_args", "Give the guest address as an origin, such as https://media.example.net");

/** A guest address as an http or https origin, with no path, query, fragment, or credentials. */
export const requireGuestAddress = (typed: string): string => {
  const url = urlOf(typed.trim()) ?? refuseAddress();

  return (url.protocol === "https:" || url.protocol === "http:") &&
    url.username === "" &&
    url.password === "" &&
    url.pathname === "/" &&
    url.search === "" &&
    url.hash === ""
    ? url.origin
    : refuseAddress();
};
