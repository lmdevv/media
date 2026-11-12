import type { PlatformSdk } from "@media/sdk/promise";
import { Brand } from "effect";

type ApiKeys = PlatformSdk["core"]["auth"]["apiKeys"];

/** A scope an API key can hold. */
export type KeyScope = Parameters<ApiKeys["create"]>[0]["scopes"][number];

/** One of the person's API keys as `core.auth.apiKeys.list` lists it, without its secret. */
export type ApiKey = Awaited<ReturnType<ApiKeys["list"]>>["page"][number];

/** The ID of an API key. */
export type ApiKeyId = ApiKey["keyId"];

/** A key ID from a route parameter; the core answers `NotFound` for one that names no key. */
export const asApiKeyId = Brand.nominal<ApiKeyId>();

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

/** The broadest permission among `scopes`, in `KEY_PERMISSIONS` order, or none. */
export const broadestLabel = (scopes: ReadonlyArray<KeyScope>): string =>
  KEY_PERMISSIONS.reduce<string>(
    (found, permission) => (scopes.includes(permission.scope) ? permission.label : found),
    "",
  );

/** A key's muted detail: `Expired` once it ran out, else its broadest permission. */
export const keyDetail = (key: ApiKey, now: number): string =>
  key.expiresAt !== null && key.expiresAt <= now ? "Expired" : broadestLabel(key.scopes);
