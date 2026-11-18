import type { PlatformSdk } from "@media/sdk/promise";

type Result<Method> = Method extends (...args: never) => Promise<infer A> ? A : never;

/** The core's server summary. */
export type ServerInfo = Result<PlatformSdk["core"]["server"]["info"]>;

/** Who is signed in, how, and with which scopes. */
export type Me = Result<PlatformSdk["core"]["auth"]["sessions"]["current"]>;

export type UserId = Me["userId"];

/** A device's picker as the core shows it. */
export type PickerView = Result<PlatformSdk["core"]["devices"]["picker"]["show"]>;

export type SharedPicker = Extract<PickerView, { readonly mode: "shared" }>;

/** One person's tile on a shared device. */
export type SharedTile = SharedPicker["tiles"][number];

/** The approval a shared device is waiting on. */
export type Approval = NonNullable<SharedPicker["approval"]>;

/** A sign-in proof that lifts a tile's lock. */
export type TileProof = NonNullable<Parameters<PlatformSdk["session"]["openTile"]>[0]["proof"]>;
