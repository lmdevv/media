import { levels } from "../../../commands/access";
import type {
  Level,
  LibraryId,
  ResourceType,
  Restrictions,
  resourceTypes,
} from "../../../commands/access";
import { roleScopes } from "../../../commands/scopes";
import type { ContentDomain, ContentVerb, CredentialScope, Role } from "../../../commands/scopes";
import type { Doc, Id } from "../../_generated/dataModel";

/** A user row that is a person: someone with a role who signs in with a password. */
export type PersonDoc = Extract<Doc<"users">, { readonly kind: "person" }>;

/**
 * Who acts. A person has a role, the scopes their credential holds now, and their restrictions. A
 * service, such as the media server, has no role and no restrictions.
 */
export type Principal =
  | {
      readonly kind: "person";
      readonly userId: Id<"users">;
      readonly role: Role;
      readonly scopes: ReadonlyArray<CredentialScope>;
      readonly restrictions: Restrictions | null;
    }
  | {
      readonly kind: "service";
      readonly userId: Id<"users">;
      readonly scopes: ReadonlyArray<CredentialScope>;
    };

/** A movie's rating as the minimum viewer age it needs (G 0, PG 7, PG-13 13, R 17, NC-17 18). */
export type Rating =
  | { readonly kind: "unrated" }
  | { readonly kind: "rated"; readonly age: number };

/** The facts restrictions read about one thing, by its domain. */
export type ContentFacts =
  | { readonly domain: "movies"; readonly rating: Rating }
  | { readonly domain: "music"; readonly explicit: boolean };

/** A thing in a content domain, with what the loader read about it for this principal. */
export interface ContentResource {
  readonly on: "content";
  readonly domain: ContentDomain;
  /** The strongest level any grant gives the principal: their own, a group's, or the household's. */
  readonly level: Level | null;
  /** The library it lives in, which the allowed-libraries restriction compares; null for none. */
  readonly library: LibraryId | null;
  /** Null for a container with no rating of its own, such as a library or a playlist. */
  readonly facts: ContentFacts | null;
}

/** The table that holds a resource type's rows. */
export type TableOf<T extends ResourceType> = (typeof resourceTypes)[T]["table"];

/** One row of a resource type, by its type and id. */
export interface ResourceRef<T extends ResourceType> {
  readonly type: T;
  readonly id: Id<TableOf<T>>;
}

type Placement = Pick<ContentResource, "domain" | "library" | "facts">;

const ratingOf = (age: number | null): Rating =>
  age === null ? { kind: "unrated" } : { kind: "rated", age };

/** How to place a row of each resource type: one entry per type, or `tsc` fails. */
type Placements = { readonly [T in ResourceType]: (doc: Doc<TableOf<T>>) => Placement };

const placements: Placements = {
  probe: (probe) => ({
    domain: probe.domain,
    library: probe._id,
    facts:
      probe.domain === "movies"
        ? { domain: "movies", rating: ratingOf(probe.age) }
        : { domain: "music", explicit: probe.explicit },
  }),
};

/** A row of a resource type as `can` sees it, at the level the principal's grants give them. */
export const resourceOf = <T extends ResourceType>(
  type: T,
  doc: Doc<TableOf<T>>,
  level: Level | null,
): ContentResource => ({ on: "content", level, ...placements[type](doc) });

/** The account an account action changes. */
export type AccountTarget =
  | {
      readonly kind: "person";
      readonly userId: Id<"users">;
      readonly role: Role;
      readonly restricted: boolean;
    }
  | { readonly kind: "service"; readonly userId: Id<"users"> };

/** Someone's account, as an account action's target. */
export interface AccountResource {
  readonly on: "account";
  readonly target: AccountTarget;
}

/** The server as a whole, the target of a server-wide action. */
export interface ServerResource {
  readonly on: "server";
}

/** The server, for `can(principal, "invite", SERVER)`. */
export const SERVER: ServerResource = { on: "server" };

/** Why `can` refused. */
export type Because =
  | "service"
  | "no-grant"
  | "restricted"
  | "scope"
  | "level"
  | "actor"
  | "self"
  | "service-target"
  | "target-role"
  | "restricted-target";

/**
 * An access decision. `hidden` answers as if the thing did not exist, so a private thing stays
 * private from everyone, admins included; `forbidden` refuses something the principal can see.
 */
export type Decision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly refusal: "hidden" | "forbidden";
      readonly because: Because;
    };

/** What can be done to a thing in a content domain. `manage` shares, renames, and deletes it. */
export const contentActions = ["view", "play", "edit", "manage"] as const;

/** What can be done to someone's account. */
export const accountActions = [
  "setRole",
  "resetPassword",
  "restrict",
  "viewRestrictions",
  "joinGroup",
  "handOverOwnership",
] as const;

/** What can be done to the server as a whole. */
export const serverActions = ["invite", "manageGroups"] as const;

/** An action on content. */
export type ContentAction = (typeof contentActions)[number];

/** An action on an account. */
export type AccountAction = (typeof accountActions)[number];

/** A server-wide action. */
export type ServerAction = (typeof serverActions)[number];

interface ContentRule {
  readonly verb: ContentVerb;
  readonly level: Level;
}

interface AccountRule {
  readonly scope: CredentialScope;
  /** The roles that may act, when narrower than every role holding the scope. */
  readonly actors?: ReadonlyArray<Role>;
  /** `refuse`: never on oneself. `allow`: oneself like anyone. `always`: oneself needs no scope. */
  readonly self: "refuse" | "allow" | "always";
  readonly targets: ReadonlyArray<Role>;
  /** The target must carry no restrictions. */
  readonly unrestricted: boolean;
}

interface ServerRule {
  readonly scope: CredentialScope;
}

type ContentRules = { readonly [A in ContentAction]: ContentRule };

type AccountRules = { readonly [A in AccountAction]: AccountRule };

type ServerRules = { readonly [A in ServerAction]: ServerRule };

const contentRules: ContentRules = {
  view: { verb: "read", level: "view" },
  play: { verb: "play", level: "view" },
  edit: { verb: "edit", level: "edit" },
  manage: { verb: "edit", level: "manage" },
};

/** What a content action needs on a thing: a scope of its domain and a grant level. */
export interface ContentNeeds {
  readonly scope: CredentialScope;
  readonly level: Level;
}

/** The scope and the grant level a content action needs on a thing in `domain`. */
export const contentNeeds = (action: ContentAction, domain: ContentDomain): ContentNeeds => ({
  scope: `${domain}:${contentRules[action].verb}`,
  level: contentRules[action].level,
});

const PEOPLE: ReadonlyArray<Role> = ["admin", "member"];

const accountRules: AccountRules = {
  setRole: { scope: "admin", self: "refuse", targets: PEOPLE, unrestricted: true },
  resetPassword: { scope: "admin", self: "refuse", targets: PEOPLE, unrestricted: false },
  restrict: { scope: "admin", self: "refuse", targets: ["member"], unrestricted: false },
  viewRestrictions: { scope: "admin", self: "always", targets: ["member"], unrestricted: false },
  joinGroup: {
    scope: "admin",
    self: "allow",
    targets: ["owner", "admin", "member"],
    unrestricted: false,
  },
  handOverOwnership: {
    scope: "admin",
    actors: ["owner"],
    self: "refuse",
    targets: PEOPLE,
    unrestricted: true,
  },
};

const serverRules: ServerRules = {
  invite: { scope: "admin" },
  manageGroups: { scope: "admin" },
};

const ALLOWED: Decision = { allowed: true };

const hidden = (because: Because): Decision => ({ allowed: false, refusal: "hidden", because });

const forbidden = (because: Because): Decision => ({
  allowed: false,
  refusal: "forbidden",
  because,
});

const rank = (level: Level): number => levels.indexOf(level);

const hiddenBy = (limits: Restrictions, resource: ContentResource): boolean => {
  const { library, facts } = resource;

  if (limits.libraries !== null && library !== null && !limits.libraries.includes(library)) {
    return true;
  }

  if (facts?.domain === "movies") {
    return facts.rating.kind === "unrated"
      ? limits.hideUnrated
      : limits.maxMovieAge !== null && facts.rating.age > limits.maxMovieAge;
  }

  return facts?.domain === "music" && facts.explicit && limits.hideExplicitMusic;
};

const decideContent = (
  principal: Principal,
  action: ContentAction,
  resource: ContentResource,
): Decision => {
  const needs = contentNeeds(action, resource.domain);

  if (principal.kind === "service") return hidden("service");

  if (resource.level === null) return hidden("no-grant");

  if (principal.restrictions !== null && hiddenBy(principal.restrictions, resource)) {
    return hidden("restricted");
  }

  if (!principal.scopes.includes(needs.scope)) return forbidden("scope");

  return rank(resource.level) < rank(needs.level) ? forbidden("level") : ALLOWED;
};

const decideAccount = (
  principal: Principal,
  rule: AccountRule,
  { target }: AccountResource,
): Decision => {
  const self = principal.userId === target.userId;

  if (self && rule.self === "always" && target.kind === "person") return ALLOWED;

  if (!principal.scopes.includes(rule.scope)) return forbidden("scope");

  if (
    principal.kind === "service" ||
    (rule.actors !== undefined && !rule.actors.includes(principal.role))
  ) {
    return forbidden("actor");
  }

  if (self && rule.self === "refuse") return forbidden("self");

  if (target.kind === "service") return forbidden("service-target");

  if (!rule.targets.includes(target.role)) return forbidden("target-role");

  return rule.unrestricted && target.restricted ? forbidden("restricted-target") : ALLOWED;
};

const decideServer = (principal: Principal, rule: ServerRule): Decision =>
  principal.kind === "person" && principal.scopes.includes(rule.scope)
    ? ALLOWED
    : forbidden("scope");

const isContentAction = (action: string): action is ContentAction =>
  contentActions.some((known) => known === action);

const isAccountAction = (action: string): action is AccountAction =>
  accountActions.some((known) => known === action);

const isServerAction = (action: string): action is ServerAction =>
  serverActions.some((known) => known === action);

/**
 * The one access decision (ADR 0005): role, credential scopes, grants, and restrictions, from
 * facts the caller loaded. Content needs a grant, so admins see no one's private things; a
 * missing grant, a restriction, and a service are all `hidden`.
 */
export function can(
  principal: Principal,
  action: ContentAction,
  resource: ContentResource,
): Decision;
export function can(
  principal: Principal,
  action: AccountAction,
  resource: AccountResource,
): Decision;
export function can(principal: Principal, action: ServerAction, resource: ServerResource): Decision;
export function can(
  principal: Principal,
  action: ContentAction | AccountAction | ServerAction,
  resource: ContentResource | AccountResource | ServerResource,
): Decision {
  if (resource.on === "content" && isContentAction(action)) {
    return decideContent(principal, action, resource);
  }

  if (resource.on === "account" && isAccountAction(action)) {
    return decideAccount(principal, accountRules[action], resource);
  }

  if (resource.on === "server" && isServerAction(action)) {
    return decideServer(principal, serverRules[action]);
  }

  throw new Error(`${action} is not an action on ${resource.on}`);
}

const NO_SCOPES: ReadonlyArray<CredentialScope> = [];

const allowedScopes = (user: Doc<"users">): ReadonlyArray<CredentialScope> =>
  user.kind === "service" ? NO_SCOPES : roleScopes[user.role];

/**
 * The scopes a session holds now: a password session holds its role's, an API key or a device
 * the ones it was given that its role still allows. A service holds none yet.
 */
export const heldScopes = (
  session: Doc<"authSessions">,
  user: Doc<"users">,
): Array<CredentialScope> => {
  const allowed = allowedScopes(user);

  return session.kind === "password"
    ? [...allowed]
    : session.scopes.filter((scope) => allowed.includes(scope));
};

/** A person's restrictions; only a member carries them. */
export const restrictionsOf = (person: PersonDoc): Restrictions | null =>
  person.role === "member" ? (person.restrictions ?? null) : null;

/**
 * The principal a user row stands for, holding `scopes`. Without them it holds what the row alone
 * allows, which is what a link checks of its maker, who has no session in the call.
 */
export const principalOf = (
  user: Doc<"users">,
  scopes: ReadonlyArray<CredentialScope> = allowedScopes(user),
): Principal =>
  user.kind === "service"
    ? { kind: "service", userId: user._id, scopes }
    : {
        kind: "person",
        userId: user._id,
        role: user.role,
        scopes,
        restrictions: restrictionsOf(user),
      };

/** A user row as the target of an account action. */
export const accountTarget = (user: Doc<"users">): AccountResource => ({
  on: "account",
  target:
    user.kind === "service"
      ? { kind: "service", userId: user._id }
      : {
          kind: "person",
          userId: user._id,
          role: user.role,
          restricted: restrictionsOf(user) !== null,
        },
});

/**
 * Whether a role change must end every session and key of the person: the new role lacks a scope
 * the old one held. That covers losing the right to make invites and reset links, so the links
 * the person made stop working too (ADR 0003, ADR 0005).
 */
export const endsCredentials = (from: Role, to: Role): boolean => {
  const held: ReadonlyArray<CredentialScope> = roleScopes[from];
  const kept: ReadonlyArray<CredentialScope> = roleScopes[to];

  return held.some((scope) => !kept.includes(scope));
};

/** A kid: a member an admin restricted. Shared devices lock their tiles on it. */
export const isKid = (user: Doc<"users">): boolean =>
  user.kind === "person" && restrictionsOf(user) !== null;
