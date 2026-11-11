import type { PlatformSdk } from "@media/sdk/promise";

type ApiKeys = PlatformSdk["core"]["auth"]["apiKeys"];

/** A scope an API key can hold. */
export type KeyScope = Parameters<ApiKeys["create"]>[0]["scopes"][number];

/** The ID of an API key, as `core.auth.apiKeys.create` answers it. */
export type ApiKeyId = Awaited<ReturnType<ApiKeys["create"]>>["keyId"];

/** H12: what each API key permission is called, in the order Create API Key lists them. */
export const KEY_PERMISSIONS: ReadonlyArray<{ readonly scope: KeyScope; readonly label: string }> =
  [
    { scope: "movies:read", label: "Read Library" },
    { scope: "movies:play", label: "Playback" },
    { scope: "movies:edit", label: "Manage Libraries" },
    { scope: "admin", label: "Manage Users" },
  ];

/** The permissions a person may put on a key: only the scopes their own session holds. */
export const grantablePermissions = (
  held: ReadonlyArray<string>,
): ReadonlyArray<(typeof KEY_PERMISSIONS)[number]> =>
  KEY_PERMISSIONS.filter((permission) => held.includes(permission.scope));

/** A key made on this phone since the app opened. */
export interface MadeKey {
  readonly keyId: ApiKeyId;
  readonly name: string;
  /** The broadest permission it holds, such as `Playback`, for its row. */
  readonly detail: string;
}

/** The broadest permission among `scopes`, in `KEY_PERMISSIONS` order, or none. */
export const broadestLabel = (scopes: ReadonlyArray<KeyScope>): string =>
  KEY_PERMISSIONS.reduce<string>(
    (found, permission) => (scopes.includes(permission.scope) ? permission.label : found),
    "",
  );

/**
 * The keys made on this phone since the app opened, newest first. The core has no query that lists
 * a person's keys, so API Keys can show, and revoke by ID, only the keys made here; every key ends
 * with End All Keys.
 */
export interface MadeKeys {
  readonly list: () => ReadonlyArray<MadeKey>;
  readonly subscribe: (listener: () => void) => () => void;
  readonly add: (key: MadeKey) => void;
  readonly revoked: (keyId: ApiKeyId) => void;
  readonly endedAll: () => void;
}

/** An empty list of keys made here. */
export const madeKeys = (): MadeKeys => {
  let keys: ReadonlyArray<MadeKey> = [];
  const listeners = new Set<() => void>();

  const set = (next: ReadonlyArray<MadeKey>): void => {
    keys = next;

    for (const listener of listeners) listener();
  };

  return {
    list: () => keys,
    subscribe: (listener) => {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
    add: (key) => set([key, ...keys.filter((each) => each.keyId !== key.keyId)]),
    revoked: (keyId) => set(keys.filter((each) => each.keyId !== keyId)),
    endedAll: () => set([]),
  };
};
