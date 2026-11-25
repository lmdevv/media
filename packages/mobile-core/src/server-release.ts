/**
 * Whether the connected server runs a newer Lar release than this app. The owner updates the
 * server first, so an app older than its server meets answers it can't read, and the update line
 * tells that apart from a bug.
 */
import { Release, ReleaseOrder } from "@media/contracts/release";
import type { ProtocolError } from "@media/sdk/effect";
import { Option, Order, Schema } from "effect";

import { readHealth } from "./server";

/** An answer this app couldn't read, as the SDK fails it. */
export type UnreadableAnswer = Pick<ProtocolError, "_tag">;

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
  /**
   * Reads the server's release again for an answer the app couldn't read. One read is out at a
   * time. An answer that arrives during a read gets one more read after it, since the read that is
   * out may have left before the server changed.
   */
  readonly readAgain: () => void;
}

/** The one server the app follows now, null while none. */
let followed: Followed | null = null;

let follows = 0;

/** Answers this app couldn't read that have already asked for the release again. */
const reread = new WeakSet<UnreadableAnswer>();

const isNewer = Order.isGreaterThan(ReleaseOrder);

/**
 * Asks to update the app while the server it follows runs a newer release than the app; null
 * while either release is unknown, while they match, and while the server is older.
 */
export const updateLine = (): string | null =>
  followed === null ? null : updateLineAgainst(followed.server);

/**
 * `updateLine` against `server`, a release a screen read from the followed server itself, in place
 * of the one the follow last read.
 */
export const updateLineAgainst = (server: Option.Option<Release>): string | null => {
  if (followed === null) return null;
  const { app, device } = followed;

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
  let asked = 0;

  const mine: Followed = {
    follow: ++follows,
    app: Schema.decodeUnknownOption(Release)(app.version),
    device: app.device,
    server: Option.none(),
    readAgain: () => {
      readAgain();
    },
  };

  followed = mine;

  const refresh = async (): Promise<void> => {
    const ask = ++asked;
    const health = await readHealth(mediaUrl);

    if (ask !== asked || followed?.follow !== mine.follow || Option.isNone(health)) return;

    followed = { ...followed, server: health.value.release };
  };

  let out = false;
  let again = false;

  const readAgain = (): void => {
    if (out) {
      again = true;

      return;
    }

    const settled = (): void => {
      out = false;

      if (again && followed?.follow === mine.follow) readAgain();

      again = false;
    };

    out = true;
    void refresh().then(settled, settled);
  };

  const stop = (): void => {
    asked += 1;

    if (followed?.follow === mine.follow) followed = null;
  };

  return { refresh, stop };
};

/**
 * Reads the followed server's release again after `unreadable`, an answer this app couldn't read:
 * the server may have been updated while the app stayed open. Each answer asks once, however often
 * its line is described, and the read belongs to whichever server the app follows now. A burst
 * of answers sends two requests at most: the one out, and one after the last answer arrived.
 */
export const rereadAfter = (unreadable: UnreadableAnswer): void => {
  if (followed === null || reread.has(unreadable)) return;

  reread.add(unreadable);
  followed.readAgain();
};
