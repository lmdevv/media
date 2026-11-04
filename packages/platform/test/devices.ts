import { ConvexHttpClient } from "convex/browser";
import type { FunctionReturnType } from "convex/server";

import type { Restrictions } from "../commands/access";
import type { AssignableRole } from "../commands/scopes";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { sessionOf } from "./probe";
import type { Session } from "./probe";
import { createPerson, signIn, signInAs } from "./sign-in";
import type { Person, SignedIn } from "./sign-in";
import type { CoreStack } from "./stack-env";

const KID: Restrictions = {
  maxMovieAge: 7,
  hideUnrated: false,
  hideExplicitMusic: true,
  libraries: null,
};

/** A signed-in person with the credentials that signed them in. */
export interface Member extends Session {
  readonly person: Person;
}

/** A registered device and the device code its app keeps. */
export interface Device {
  readonly deviceId: Id<"devices">;
  readonly device: string;
}

/** What a picker shows. */
export type Picker = FunctionReturnType<typeof api.core.devices.picker.show>;

/** A proof for a locked tile, as the `tile` provider takes it. */
export type TileProof =
  | { readonly kind: "password"; readonly by: Id<"users">; readonly password: string }
  | { readonly kind: "code"; readonly by: Id<"users">; readonly code: string }
  | { readonly kind: "approval"; readonly approvalId: Id<"tileApprovals"> };

export const member = async (
  stack: CoreStack,
  label: string,
  role: AssignableRole = "member",
): Promise<Member> => {
  const person = await createPerson(stack, label, role);

  return { ...(await sessionOf(await signInAs(stack, person))), person };
};

/** People a test listed on shared devices, which it takes off again. */
export interface Listings {
  /** Lists an adult, who opts in themselves. */
  readonly adult: (who: Member) => Promise<Member>;
  /** Makes `who` a kid and lists them, as `admin`. */
  readonly kid: (admin: Member, who: Member) => Promise<Member>;
  /** Takes everyone listed so far off again. */
  readonly clear: () => Promise<void>;
}

/**
 * Lists people on shared devices and takes them off again. Every shared device lists the same
 * people, so a test that leaves someone listed changes every later test's locks.
 */
export const listings = (): Listings => {
  const undo: Array<() => Promise<null>> = [];

  return {
    adult: async (who) => {
      const setListed = (listed: boolean) =>
        who.signedIn.client.mutation(api.core.devices.tiles.setListed, {
          userId: who.userId,
          listed,
        });

      await setListed(true);
      undo.push(() => setListed(false));

      return who;
    },
    kid: async (admin, who) => {
      const client = admin.signedIn.client;

      await client.mutation(api.core.restrictions.set, { userId: who.userId, restrictions: KID });

      const setListed = (listed: boolean) =>
        client.mutation(api.core.devices.tiles.setListed, { userId: who.userId, listed });

      await setListed(true);
      undo.push(() => setListed(false));

      return who;
    },
    clear: async () => {
      await Promise.all(undo.splice(0).map((step) => step()));
    },
  };
};

export const enroll = (signedIn: SignedIn, name: string, device?: string): Promise<Device> =>
  signedIn.client.action(
    api.core.devices.registry.enroll,
    device === undefined ? { name } : { name, device },
  );

/** A device that a fresh sign-in of `admin` registered and `admin` then made shared. */
export const sharedDevice = async (
  stack: CoreStack,
  admin: Member,
  name = "Living room TV",
): Promise<Device & { readonly setUp: SignedIn }> => {
  const setUp = await signInAs(stack, admin.person);
  const device = await enroll(setUp, name);

  await admin.signedIn.client.mutation(api.core.devices.registry.setMode, {
    deviceId: device.deviceId,
    mode: "shared",
  });

  return { ...device, setUp };
};

/** A client with no session, as a shared device at its picker is. */
export const anonymous = (stack: CoreStack): ConvexHttpClient =>
  new ConvexHttpClient(stack.url, { logger: false });

export const picker = (stack: CoreStack, device: Device): Promise<Picker> =>
  anonymous(stack).query(api.core.devices.picker.show, { device: device.device });

export const sharedTiles = (shown: Picker) => {
  if (shown.mode !== "shared") throw new Error("the picker is a personal device's");

  return shown.tiles;
};

/** The tile a shared picker shows for `userId`. */
export const tileIn = (shown: Picker, userId: Id<"users">) => {
  const tile = sharedTiles(shown).find((candidate) => candidate.userId === userId);

  if (tile === undefined) throw new Error(`${userId} has no tile on this picker`);

  return tile;
};

/** Opens `userId`'s tile on a shared device through the `tile` provider. */
export const openTile = (
  stack: CoreStack,
  device: Device,
  userId: Id<"users">,
  proof?: TileProof,
): Promise<SignedIn> =>
  signIn(
    stack,
    "tile",
    proof === undefined
      ? { device: device.device, userId }
      : { device: device.device, userId, proof },
  );
