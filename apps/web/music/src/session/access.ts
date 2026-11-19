import type { sessionAccess } from "@media/ui/lib/session-identity";

/** Music guests stay on the share; household members use the music app. */
export const musicAccess = (
  access: ReturnType<typeof sessionAccess>,
  guestRoute: boolean,
): "render" | "guest" | "home" | "wait" => {
  if (access === "guest") return guestRoute ? "render" : "guest";

  if (access === "household") return guestRoute ? "home" : "render";

  return "wait";
};
