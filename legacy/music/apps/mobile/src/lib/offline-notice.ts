/**
 * The words of the notice the app shows while its server is out of reach: the card under a tab
 * root's title (Paper's D11, D14, and G04 on a phone with nothing downloaded) and the one-line bar
 * on a pushed page (D12, D13).
 */
import type { ServerReach } from "./server-reach";

/** What the notice says, and whether it offers Try again. */
export interface OfflineNotice {
  /** Offline since launch, or lost after the server answered: picks the glyph. */
  readonly kind: "offline" | "reconnecting";
  readonly title: string;
  readonly body: string;
  /** The bar's single word. */
  readonly label: string;
  readonly retry: boolean;
}

/** What the notice depends on. */
export interface OfflineNoticeInput {
  readonly reach: ServerReach;
  /** This phone holds a downloaded song, so music still plays. */
  readonly hasDownloads: boolean;
  /** The server as the app names it, such as `music.example.com`. */
  readonly host: string;
  /** Music is playing, or about to, on this phone. */
  readonly playingHere: boolean;
}

/**
 * The notice for where the app stands with its server; null while the server answers. Try again
 * opens a fresh connection, which restarts the player, so it shows only on a launch that never
 * reached the server and only while nothing plays here. Convex keeps retrying on its own anyway.
 */
export const offlineNotice = ({
  reach,
  hasDownloads,
  host,
  playingHere,
}: OfflineNoticeInput): OfflineNotice | null => {
  if (reach === "online") return null;

  if (reach === "offline") {
    return {
      kind: "offline",
      title: "You’re offline",
      body: `${host} is out of reach. Everything you downloaded still plays.`,
      label: "Offline",
      retry: !playingHere,
    };
  }

  return {
    kind: "reconnecting",
    title: `Reconnecting to ${host}`,
    body: hasDownloads
      ? "Downloads keep playing. Your full library and queue come back when the server answers."
      : "Your queue is saved. Changes will be available when you reconnect.",
    label: "Reconnecting",
    retry: false,
  };
};
