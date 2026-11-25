/**
 * Whether the connected server runs a newer Lar release than this app. The owner updates the
 * server first, so an app older than its server meets answers it can't read, and the update line
 * tells that apart from a bug.
 */
import { Release, ReleaseOrder } from "@media/contracts/release";
import { Option, Order, Schema } from "effect";

import { readHealth } from "./server";

/** What the app runs on, as the update line names it. */
export type DeviceFamily = "iPhone" | "iPad";

/** This build of an app, as the update line compares and names it. */
export interface ThisApp {
  /**
   * The app's version, as its app.json gives it (`Constants.expoConfig?.version`). A value that
   * is not a release leaves the comparison unknown.
   */
  readonly version: string | undefined;
  readonly device: DeviceFamily;
}

/** A server the app follows, and what it has read of the two releases. */
interface Followed {
  /** Which `followServer` call this is: a later call for the same server is another follow. */
  readonly follow: number;
  readonly app: Option.Option<Release>;
  readonly device: DeviceFamily;
  /** The server's release from its latest readable health answer; none until one. */
  readonly server: Option.Option<Release>;
}

/** The one server the app follows now, null while none. */
let followed: Followed | null = null;

let follows = 0;

const isNewer = Order.isGreaterThan(ReleaseOrder);

/**
 * Asks to update the app while the server it follows runs a newer release than the app; null
 * while either release is unknown, while they match, and while the server is older.
 */
export const updateLine = (): string | null => {
  if (followed === null) return null;
  const { app, server, device } = followed;

  return Option.isSome(app) && Option.isSome(server) && isNewer(server.value, app.value)
    ? `Update Lar on this ${device}. Its server runs a newer version.`
    : null;
};

/** One followed server. `refresh` reads its release again, and `stop` lets go of it. */
export interface ServerFollow {
  readonly refresh: () => Promise<void>;
  readonly stop: () => void;
}

/**
 * Follows the server at `mediaUrl` for `updateLine`, in place of any server followed before.
 * Each `refresh` reads its release from its health check. An answer applies only while this follow
 * is the current one and no later `refresh` has started; a server that doesn't answer keeps the
 * release it last named.
 */
export const followServer = (mediaUrl: string, app: ThisApp): ServerFollow => {
  const mine: Followed = {
    follow: ++follows,
    app: Schema.decodeUnknownOption(Release)(app.version),
    device: app.device,
    server: Option.none(),
  };

  followed = mine;
  let asked = 0;

  const refresh = async (): Promise<void> => {
    const ask = ++asked;
    const health = await readHealth(mediaUrl);

    if (ask !== asked || followed?.follow !== mine.follow || Option.isNone(health)) return;

    followed = { ...followed, server: health.value.release };
  };

  const stop = (): void => {
    asked += 1;

    if (followed?.follow === mine.follow) followed = null;
  };

  return { refresh, stop };
};
