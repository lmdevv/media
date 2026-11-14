import type { PlatformSdk } from "@media/sdk/promise";

type Result<Method> = Method extends (...args: never) => Promise<infer A> ? A : never;

type RowOf<Method> =
  Result<Method> extends { readonly page: ReadonlyArray<infer Row> } ? Row : never;

type Core = PlatformSdk["core"];

/** A user as the users list shows them. */
export type User = RowOf<Core["accounts"]["users"]["list"]>;

export type Role = User["role"];

/** A role an admin can give. */
export type AssignableRole = Parameters<Core["accounts"]["users"]["setRole"]>[0]["role"];

/** An invite that still works. */
export type Invite = RowOf<Core["accounts"]["invites"]["list"]>;

export type Group = RowOf<Core["permissions"]["groups"]["list"]>;

/** A person in a group. */
export type Member = RowOf<Core["permissions"]["groups"]["members"]>;

/** A library as the libraries list shows it. */
export type Library = RowOf<Core["libraries"]["list"]>;

export type LibraryId = Library["libraryId"];

/** A content domain, the kind of a library. */
export type LibraryKind = Library["kind"];

/** A grant level, weakest first: view, edit, manage. */
export type Level = Library["level"];

/** A library with its items, folders, and latest scan. */
export type LibraryDetail = Result<Core["libraries"]["get"]>;

/** A job as the jobs list shows it, of any kind. */
export type Job = RowOf<Core["jobs"]["list"]>;

/** Who something is shared with, and at which level. */
export type Grant = RowOf<Core["permissions"]["grants"]["list"]>;

/** Who a grant reaches, as `grants.set` takes it. */
export type Principal = Parameters<Core["permissions"]["grants"]["set"]>[0]["principal"];

/** A kid's limits. */
export type Restrictions = NonNullable<Result<Core["restrictions"]["get"]>>;

export type Device = RowOf<Core["devices"]["registry"]["list"]>;

export type DeviceMode = Device["mode"];

/** Whether guest links are on and their address. */
export type GuestStatus = Result<Core["guests"]["status"]>;

/** A guest link as an admin sees it. */
export type GuestLink = RowOf<Core["guests"]["links"]["list"]>;

/** A guest who opened a link. */
export type GuestVisit = RowOf<Core["guests"]["links"]["activity"]>;

/** What the media server last reported about itself; null before it ever reported. */
export type ServerStatus = Result<Core["server"]["status"]>;

/** A database backup. */
export type Backup = RowOf<Core["server"]["backups"]["list"]>;
