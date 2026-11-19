import type { sessionAccess } from "@media/ui/lib/session-identity";

/** Household members use the music app; guests go back to their share. */
export const musicAccess = (
  access: ReturnType<typeof sessionAccess>,
): "render" | "guest" | "wait" => {
  if (access === "guest") return "guest";

  if (access === "household") return "render";

  return "wait";
};
