import type { MobileData } from "../preferences";

/** The network as the player needs to know it; `unknown` when the system can't tell. */
export type Connection = "cellular" | "other" | "unknown";

/** What happens before a stream starts. */
export type MobileDataStep = "play" | "ask" | "wifiOnly";

/** The step for `preference` on `connection`. */
export const mobileDataStep = (preference: MobileData, connection: Connection): MobileDataStep => {
  if (connection !== "cellular" || preference === "allowStreaming") return "play";

  return preference === "askFirst" ? "ask" : "wifiOnly";
};

/** The quality Ask First's data-saving choice plays at on mobile data. */
export const DATA_SAVER_QUALITY = "480p" as const;
