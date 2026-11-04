import type { DeviceScope } from "@media/contracts/scopes";

/** What each grantable scope allows, as the key and device screens describe it. */
export const SCOPE_DESCRIPTIONS: Readonly<Record<DeviceScope, string>> = {
  read: "Browse libraries, search and read metadata",
  play: "Play, report watch progress and join rooms",
  account: "Profiles, PINs, API keys and devices",
  manage: "Libraries, scans and metadata fixes",
  admin: "Users, invites, backups and migration",
};

const SCOPE_ORDER: ReadonlyArray<DeviceScope> = ["read", "play", "account", "manage", "admin"];

/** `scopes` sorted into {@link SCOPE_ORDER}. */
export const sortScopes = <S extends DeviceScope>(scopes: ReadonlyArray<S>): ReadonlyArray<S> =>
  scopes.toSorted((left, right) => SCOPE_ORDER.indexOf(left) - SCOPE_ORDER.indexOf(right));
