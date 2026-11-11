import type { PlatformGrant } from "@media/sdk/promise";
import { Option, Schema } from "effect";

import type { Keychain } from "./keychain";
import type { ServerConnection } from "./server";

/** A person's account id on the core. */
export type UserId = PlatformGrant["userId"];

const UserIdText = Schema.String.pipe(Schema.brand("Id<users>"));

/**
 * What the phone's shared keychain holds for every [media] app on it (D48): the server, the person
 * signed in on the phone, and the phone's device grant for them. No session lives here: each app
 * exchanges the grant for a session of its own.
 */
export interface PhoneAccount {
  /** The media server's address, such as `https://cinema.home`. */
  readonly server: string;
  readonly userId: UserId;
  /** The grant `core.devices.deviceGrants.issue` showed, `dg_` and its secret. */
  readonly grant: string;
}

const PhoneAccountJson = Schema.fromJsonString(
  Schema.Struct({ server: Schema.String, userId: UserIdText, grant: Schema.String }),
);

/** What this app keeps in its own keychain about its sign-in on one server. */
export interface AppRecord {
  /** The app's device code, `dv_` and its secret, once the app enrolled on this server. */
  readonly device: string | null;
  /**
   * Who this app last signed in as on this server, or null before it ever signed in. Signing out
   * keeps it, so the sign-in screen can name the person.
   */
  readonly person: { readonly userId: UserId; readonly username: string } | null;
  /**
   * True once this app began any sign-in of its own on this server: written before the call that
   * opens a session, so a crash at any later point leaves it set. From then on the app never
   * exchanges the phone's grant again, and an app whose session ends asks for the password (D59).
   */
  readonly opened: boolean;
}

const AppRecordJson = Schema.fromJsonString(
  Schema.Struct({
    device: Schema.NullOr(Schema.String),
    person: Schema.NullOr(Schema.Struct({ userId: UserIdText, username: Schema.String })),
    opened: Schema.Boolean,
  }),
);

const ConnectionJson = Schema.fromJsonString(
  Schema.Struct({ mediaUrl: Schema.String, convexUrl: Schema.String, moviesUrl: Schema.String }),
);

const PHONE_KEY = "media.phone";

const CONNECTION_KEY = "media.server";

/** A server's address as a keychain key: one record per server, so nothing crosses servers. */
const serverKey = (server: string): string => server.replace(/[^\w.-]/gu, "_");

const appKey = (server: string): string => `media.app.${serverKey(server)}`;

/**
 * Where the SDK keeps this app's session for the server at `mediaUrl`, in the app's own keychain
 * (D48). Each server has its own key, so a token saved late for one server never reaches another.
 */
export const sessionKeyFor = (mediaUrl: string): string => `media.session.${serverKey(mediaUrl)}`;

const readJson = <A>(
  keychain: Keychain,
  key: string,
  schema: Schema.Codec<A, string>,
): A | null => {
  const stored = keychain.read(key);

  return stored === null ? null : Option.getOrNull(Schema.decodeOption(schema)(stored));
};

/** The phone's shared account, or null when no app on it signed in with a password. */
export const readPhoneAccount = (shared: Keychain): PhoneAccount | null =>
  readJson(shared, PHONE_KEY, PhoneAccountJson);

/**
 * Keeps the phone's shared account for every app on it, or forgets it with null. Throws
 * `KeychainWriteFailed` when the keychain refuses it.
 */
export const writePhoneAccount = (shared: Keychain, account: PhoneAccount | null): void => {
  shared.writeDurably(
    PHONE_KEY,
    account === null ? null : Schema.encodeSync(PhoneAccountJson)(account),
  );
};

const NO_RECORD: AppRecord = { device: null, person: null, opened: false };

/** What this app keeps about its sign-in on `server`. */
export const readAppRecord = (own: Keychain, server: string): AppRecord =>
  readJson(own, appKey(server), AppRecordJson) ?? NO_RECORD;

/**
 * Keeps what this app knows about its sign-in on `server`. Throws `KeychainWriteFailed` when the
 * keychain refuses it: the D59 mark must be stored, not only held in memory.
 */
export const writeAppRecord = (own: Keychain, server: string, record: AppRecord): void => {
  own.writeDurably(appKey(server), Schema.encodeSync(AppRecordJson)(record));
};

/** The server this app connects to, or null before anyone connected it. */
export const readConnection = (own: Keychain): ServerConnection | null =>
  readJson(own, CONNECTION_KEY, ConnectionJson);

/** Remembers the server this app connects to, or forgets it with null. */
export const writeConnection = (own: Keychain, connection: ServerConnection | null): void => {
  own.write(
    CONNECTION_KEY,
    connection === null ? null : Schema.encodeSync(ConnectionJson)(connection),
  );
};
