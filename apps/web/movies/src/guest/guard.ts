import type { Me } from "@/session/session";

export const guestGuard = (
  status: "loading" | "signedIn" | "signedOut",
  role: Me["role"] | undefined,
): "loading" | "unavailable" | "member" | "guest" => {
  if (status === "loading") return "loading";

  if (status === "signedOut") return "unavailable";

  if (role === undefined) return "loading";

  return role === "guest" ? "guest" : "member";
};
