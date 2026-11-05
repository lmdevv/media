import { domains } from "./command.ts";
import type { Domain } from "./command.ts";

/** A domain that holds content, such as movies or music. The core holds accounts, not content. */
export type ContentDomain = Exclude<Domain, "core">;

export const contentDomains = domains.filter(
  (domain): domain is ContentDomain => domain !== "core",
);

/**
 * What a credential may do in a content domain. `read` browses, searches, and opens details.
 * `play` streams and records progress of what the person may see; it does not need `read`. `edit`
 * makes, changes, deletes, and shares what the person's grant level allows.
 */
export const contentVerbs = ["read", "play", "edit"] as const;

type ContentVerb = (typeof contentVerbs)[number];

type DomainScope = `${ContentDomain}:${ContentVerb}`;

/** Every content domain's scopes: what a session on a shared device may hold (ADR 0006). */
export const domainScopes: ReadonlyArray<DomainScope> = contentDomains.flatMap((domain) =>
  contentVerbs.map((verb) => `${domain}:${verb}` as const),
);

/**
 * The scopes a sign-in credential can hold. `account` manages the caller's own sessions, API keys,
 * device sign-ins, password, and username. `admin` manages other people's accounts, invites, reset
 * links, groups, and restrictions. Each domain scope reaches only that domain's commands.
 */
export const credentialScopes = ["account", "admin", ...domainScopes] as const;

export type CredentialScope = (typeof credentialScopes)[number];

/**
 * Who may call a command. The generated Convex function checks it on every call: `public` needs no
 * session, `signed-in` needs any live session, and a credential scope needs a live session that
 * holds it.
 */
export const scopes = ["public", "signed-in", ...credentialScopes] as const;

/** A scope a command can require. */
export type Scope = (typeof scopes)[number];

export const assignableRoles = ["admin", "member"] as const;

/**
 * A user's platform role. The owner is the admin who holds the server; only a handover moves it. A
 * guest reaches only what a share link names, and no admin assigns the role.
 */
export const roles = ["owner", ...assignableRoles, "guest"] as const;

export type Role = (typeof roles)[number];

/**
 * Every scope each role allows, the only role-to-scope table. A password session holds all of its
 * role's scopes; an API key or a device holds the ones it was given, cut to its role's on each
 * call. A guest plays what a link names and cannot browse, search, or edit (ADR 0007).
 */
export const roleScopes = {
  owner: ["account", "admin", ...domainScopes],
  admin: ["account", "admin", ...domainScopes],
  member: ["account", ...domainScopes],
  guest: contentDomains.map((domain) => `${domain}:play` as const),
} as const satisfies { readonly [R in Role]: ReadonlyArray<CredentialScope> };
