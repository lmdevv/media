/**
 * `@media/sdk/promise`: the SDK for code that does not use Effect. It runs the Effect core in a
 * `ManagedRuntime`. Promises reject with the same tagged errors the Effect API fails with
 * (`Unauthenticated`, `NotFound`, `TransportError`, ...), so callers branch on `error._tag`.
 * `createPlatform` opens the platform deployment's client, and `createMediaServer` calls the media
 * server's own routes.
 */
export { createPlatform } from "./platform/promise";

export { signInUrlBeside, signInUrlFor } from "./platform/sign-in-url";

export { createMediaServer } from "./media-server";

export type { MediaServer, MediaServerOptions, MediaServerSession } from "./media-server";

export { openIndexedDb } from "./shared-store";

export { holdSignIn, readDevice } from "./token-storage";

export type { BrowserDevice, DeviceOrder, HeldSignIn } from "./token-storage";

export type { Channel, IdbFactory, SharedStore, SharedTransaction } from "./shared-store";

export type {
  PendingDeviceSignIn,
  PlatformGrant,
  PlatformInvite,
  PlatformOptions,
  PlatformPassword,
  PlatformReset,
  PlatformSdk,
  PlatformSession,
  PlatformTile,
  PlatformTileProof,
} from "./platform/promise";
