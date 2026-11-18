import type { PlatformSdk } from "@media/sdk/promise";

type Guests = PlatformSdk["core"]["guests"];

type Me = Awaited<ReturnType<PlatformSdk["core"]["auth"]["sessions"]["current"]>>;

/** A guest link's input target, using the SDK's command contract. */
export type GuestTarget = Extract<
  Parameters<Guests["links"]["create"]>[0]["target"],
  { kind: "item" }
>;

/** A maker's list row contains metadata, never the link's secret address. */
export type GuestLinkRow = Awaited<ReturnType<Guests["links"]["list"]>>["page"][number];

/** Account queries and link creation require a person's account session. */
export const canQueryGuestLinks = (me: Pick<Me, "kind" | "role" | "scopes"> | undefined): boolean =>
  me !== undefined &&
  me.role !== "guest" &&
  me.kind !== "tile" &&
  me.kind !== "guest" &&
  me.kind !== "apiKey" &&
  me.scopes.includes("account");

/** Sharing requires both the server switch and the member's leave. */
export const guestLinksAllowed = (
  policy: Awaited<ReturnType<Guests["status"]>> | undefined,
): boolean => policy !== undefined && policy.enabled && policy.mayShare;

/** Empty, fractional, or out-of-range expiry choices cannot create a link. */
export const guestExpiryDays = (value: string): number | null => {
  const days = Number(value);

  return Number.isInteger(days) && days >= 1 && days <= 30 ? days : null;
};

/** Matches a maker's row to exactly this item, including its domain and item type. */
export const sameGuestTarget = (left: GuestLinkRow["target"], right: GuestTarget): boolean => {
  if (left === null || left.kind !== right.kind) return false;

  return (
    left.item.domain === right.item.domain &&
    left.item.ref.type === right.item.ref.type &&
    left.item.ref.id === right.item.ref.id
  );
};
