import type { FunctionArgs } from "convex/server";

import type { DomainItem } from "../commands/access";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { sharedAdmin } from "./devices";
import type { Member } from "./devices";
import { sessionOf } from "./probe";
import type { Session } from "./probe";
import { signIn } from "./sign-in";
import type { CoreStack } from "./stack-env";

/** The guest address the stack tests configure. */
export const GUEST_ADDRESS = "https://guests.example.ts.net";

/** What a maker asks a guest link for. */
export type ShareTarget = FunctionArgs<typeof api.core.guests.links.create>["target"];

/** A guest link a maker made: its id, its address as shown once, and the code a guest opens. */
export interface Made {
  readonly linkId: Id<"shareLinks">;
  readonly url: string;
  readonly code: string;
}

/** Turns guest links on at `GUEST_ADDRESS`, as the stack's shared admin. */
export const guestsOn = async (stack: CoreStack): Promise<Member> => {
  const admin = await sharedAdmin(stack);

  await admin.signedIn.client.mutation(api.core.guests.configure, {
    enabled: true,
    address: GUEST_ADDRESS,
  });

  return admin;
};

/** The code in a guest link's address: everything after the fragment mark. */
const codeOf = (url: string): string => url.slice(url.indexOf("#") + 1);

/** `maker` makes a guest link to `target`. */
export const makeLink = async (
  maker: Member,
  target: ShareTarget,
  expiresInDays?: number,
): Promise<Made> => {
  const made = await maker.signedIn.client.action(
    api.core.guests.links.create,
    expiresInDays === undefined ? { target } : { target, expiresInDays },
  );

  return { ...made, code: codeOf(made.url) };
};

/** Signs a new guest in through a guest link's code under `name`. */
export const openLink = async (stack: CoreStack, code: string, name: string): Promise<Session> =>
  sessionOf(await signIn(stack, "guest", { code, name }));

/** A guest let in by a link `maker` makes to `item`, with guest links turned on. */
export const guestOf = async (
  stack: CoreStack,
  maker: Member,
  item: DomainItem,
  name = "Sam",
): Promise<Session> => {
  await guestsOn(stack);

  const { code } = await makeLink(maker, { kind: "item", item });

  return openLink(stack, code, name);
};
