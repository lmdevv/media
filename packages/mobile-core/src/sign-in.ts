import type {
  PendingDeviceSignIn,
  PlatformInvite,
  PlatformPassword,
  PlatformSdk,
  PlatformSession,
} from "@media/sdk/promise";
import { Predicate } from "effect";

import type { Keychain } from "./keychain";
import { readAppRecord, readPhoneAccount, writeAppRecord, writePhoneAccount } from "./records";
import type { AppRecord, UserId } from "./records";

/** The platform client calls signing in makes: a subset of `PlatformSdk`. */
export interface SignInPlatform {
  readonly session: Pick<
    PlatformSession,
    "signInWithPassword" | "setUpOwner" | "acceptInvite" | "exchangeGrant" | "signOut"
  > & {
    readonly startDeviceSignIn: (clientName: string) => Promise<PendingDeviceSignIn>;
  };
  readonly core: {
    readonly auth: {
      readonly sessions: {
        readonly current: () => Promise<{ readonly userId: UserId; readonly username: string }>;
      };
    };
    readonly devices: {
      readonly deviceGrants: {
        readonly issue: PlatformSdk["core"]["devices"]["deviceGrants"]["issue"];
      };
      readonly registry: { readonly enroll: PlatformSdk["core"]["devices"]["registry"]["enroll"] };
    };
  };
}

/** This app on this phone, signing in to one server. */
export interface Phone {
  /** The app's own keychain: its device code and who it signed in as (D48). */
  readonly own: Keychain;
  /** The phone's shared keychain access group: the server, the person, and the grant (D48). */
  readonly shared: Keychain;
  /** The media server's address, such as `https://cinema.home`. */
  readonly server: string;
  /** The name this app shows as in the person's devices, such as `Aiko's iPhone`. */
  readonly deviceName: string;
}

/**
 * Marks that this app began a sign-in of its own on this server, before the call that opens a
 * session. Every state a crash can leave from here on has the mark, so a launch asks for the
 * password and never exchanges the phone's grant silently (D59). Throws `KeychainWriteFailed` when
 * the keychain refuses the mark, so no sign-in starts without it stored.
 */
const markOpened = (phone: Phone): void => {
  const record = readAppRecord(phone.own, phone.server);

  if (!record.opened) writeAppRecord(phone.own, phone.server, { ...record, opened: true });
};

/**
 * Finishes a sign-in the platform client just opened: enrolls the app's own device and records
 * who signed in, then, for a password session, issues the phone's device grant, handing over the
 * grant the shared keychain holds so that one held by someone else is revoked (D64). The grant is
 * the last thing written, after every call succeeded. Anything that fails signs the new session
 * out again, so the app never stays signed in half way.
 */
const finish = async (
  platform: SignInPlatform,
  phone: Phone,
  opened: "password" | "other",
): Promise<void> => {
  try {
    const me = await platform.core.auth.sessions.current();
    const record = readAppRecord(phone.own, phone.server);

    const enrolled = await platform.core.devices.registry.enroll(
      record.device === null
        ? { name: phone.deviceName }
        : { name: phone.deviceName, device: record.device },
    );

    writeAppRecord(phone.own, phone.server, {
      device: enrolled.device,
      person: { userId: me.userId, username: me.username },
      opened: true,
    });

    if (opened === "password") {
      const held = readPhoneAccount(phone.shared);

      // The grant held for this server goes along, so another person's is revoked (D64).
      const issued = await platform.core.devices.deviceGrants.issue(
        held === null || held.server !== phone.server
          ? { name: phone.deviceName }
          : { name: phone.deviceName, grant: held.grant },
      );

      writePhoneAccount(phone.shared, {
        server: phone.server,
        userId: me.userId,
        grant: issued.grant,
      });
    }
  } catch (cause) {
    await platform.session.signOut().catch(() => undefined);

    throw cause;
  }
};

/**
 * Signs in with a username and password, issues the phone's grant, and enrolls the app. Rejects
 * with `Unauthenticated` for a refused password, and with `KeychainWriteFailed`, before any call,
 * when the keychain cannot store the D59 mark.
 */
export const signInWithPassword = async (
  platform: SignInPlatform,
  phone: Phone,
  credentials: PlatformPassword,
): Promise<void> => {
  markOpened(phone);
  await platform.session.signInWithPassword(credentials);
  await finish(platform, phone, "password");
};

/**
 * Creates the server's first account as its owner from the app, signs in, and enrolls. Rejects
 * with `Conflict` once the server has an owner.
 */
export const setUpOwner = async (
  platform: SignInPlatform,
  phone: Phone,
  credentials: PlatformPassword,
): Promise<void> => {
  markOpened(phone);
  await platform.session.setUpOwner(credentials);
  await finish(platform, phone, "password");
};

/** Creates an account from an invite, signs in, and enrolls. Rejects with `Expired` for a dead one. */
export const acceptInvite = async (
  platform: SignInPlatform,
  phone: Phone,
  invite: PlatformInvite,
): Promise<void> => {
  markOpened(phone);
  await platform.session.acceptInvite(invite);
  await finish(platform, phone, "password");
};

/**
 * Starts a sign-in that someone signed in elsewhere approves. `complete` waits for the approval,
 * signs in, and enrolls. A device sign-in issues no grant: only a password does (ADR 0006).
 */
export const startDeviceSignIn = async (
  platform: SignInPlatform,
  phone: Phone,
): Promise<PendingDeviceSignIn> => {
  const pending = await platform.session.startDeviceSignIn(phone.deviceName);

  return {
    userCode: pending.userCode,
    expiresAt: pending.expiresAt,
    complete: async () => {
      markOpened(phone);
      await pending.complete();
      await finish(platform, phone, "other");
    },
  };
};

/** What a launch without a session of the app's own did. */
export type LaunchSignIn =
  /** The app exchanged the phone's grant for a session of its own and is signed in. */
  | "exchanged"
  /**
   * The app began a sign-in of its own here once, whether it finished or not, and has no session
   * now: it asks for the password, never the grant, so a revocation sticks (D59).
   */
  | "askPassword"
  /** No app on the phone signed in to this server, or the core refused the grant: sign in. */
  | "signIn";

/**
 * Signs a signed-out app in silently when it never had a session of its own and the phone's shared
 * keychain holds a grant for this server, as on the first launch of the second app (ADR 0020).
 * Call it only while the platform client is signed out.
 */
export const signInOnLaunch = async (
  platform: SignInPlatform,
  phone: Phone,
): Promise<LaunchSignIn> => {
  const record = readAppRecord(phone.own, phone.server);

  // Any sign-in this app began, finished or not, rules the grant out (D59).
  if (record.opened || record.person !== null) return "askPassword";

  const account = readPhoneAccount(phone.shared);

  if (account === null || account.server !== phone.server) return "signIn";

  try {
    markOpened(phone);
  } catch (cause) {
    // Without the mark stored, a later launch could exchange again after this session is revoked.
    if (Predicate.isTagged(cause, "KeychainWriteFailed")) return "askPassword";

    throw cause;
  }

  try {
    await platform.session.exchangeGrant({ userId: account.userId, grant: account.grant });
  } catch (cause) {
    if (Predicate.isTagged(cause, "Unauthenticated")) return "signIn";

    throw cause;
  }

  await finish(platform, phone, "other");

  return "exchanged";
};

/** Who this app last signed in as on its server, for the sign-in screen to name; null before. */
export const lastPerson = (phone: Pick<Phone, "own" | "server">): AppRecord["person"] =>
  readAppRecord(phone.own, phone.server).person;
