import type { Doc } from "../../_generated/dataModel";
import type { DatabaseReader } from "../../_generated/server";
import { principalOf } from "../permissions/policy";
import type { PersonDoc, Principal, ShareResource } from "../permissions/policy";
import { guestAccessOf, switchedOnFor } from "./model";
import type { GuestAccess, LinkDoc } from "./model";

/** A guest's row: a person a share link let in. */
export type GuestDoc = Extract<Doc<"users">, { readonly role: "guest" }>;

/** Everything `can` reads about a link but what an action is about. */
export type ShareStanding = Omit<ShareResource, "about">;

type PersonPrincipal = Extract<Principal, { readonly kind: "person" }>;

const allowedOf = (person: PersonDoc): boolean =>
  person.role === "member" && person.sharesWithGuests === true;

/** The standing of a link `person`, acting as `principal`, would make now. */
export const newLinkStanding = (
  access: GuestAccess,
  principal: PersonPrincipal,
  person: PersonDoc,
): ShareStanding => ({
  on: "share",
  switchedOn: access.enabled,
  maker: { principal, allowed: allowedOf(person), backs: true },
  link: "new",
});

const stateOf = (link: LinkDoc, now: number): "open" | "revoked" | "expired" => {
  if (link.revokedAt !== null) return "revoked";

  return link.expiresAt > now ? "open" : "expired";
};

/**
 * A link's standing as `can` sees it for `guestOf`, the guest acting through it, or null when its
 * maker no longer exists as a household person. Reads nothing.
 */
export const standingOf = (
  link: LinkDoc,
  access: GuestAccess,
  maker: Doc<"users"> | null,
  guestOf: Pick<GuestDoc, "link"> | null,
  now: number,
): ShareStanding | null => {
  if (maker?.kind !== "person" || maker.role === "guest") return null;

  const principal = principalOf(maker);

  if (principal.kind !== "person") return null;

  return {
    on: "share",
    switchedOn: switchedOnFor(access, link),
    maker: {
      principal,
      allowed: allowedOf(maker),
      backs: maker.sessionGeneration === link.makerGeneration,
    },
    link: { state: stateOf(link, now), mine: guestOf?.link === link._id },
  };
};

/** The link that let a guest in, and its standing. */
export interface GuestLink {
  readonly link: LinkDoc;
  readonly standing: ShareStanding;
}

/**
 * The link that let `guest` in and its standing: its row, the switch, and its maker's row, three
 * point reads. `liveSession` runs it on every call of a guest's session, so a revoke, the switch,
 * or a change to the maker ends the guest at once, in commands and in the server's ticket watch.
 * Null when the link or its maker is gone.
 */
export const guestLinkOf = async (
  db: DatabaseReader,
  guest: GuestDoc,
  now: number,
): Promise<GuestLink | null> => {
  const [link, access] = await Promise.all([db.get(guest.link), guestAccessOf(db)]);

  const standing =
    link === null ? null : standingOf(link, access, await db.get(link.maker), guest, now);

  return link === null || standing === null ? null : { link, standing };
};
