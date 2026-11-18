import { Predicate } from "effect";

export type GuestSubmission =
  | { readonly kind: "idle" }
  | { readonly kind: "submitting" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "full" }
  | { readonly kind: "failed"; readonly message: string };

export const guestFailure = (cause: unknown): GuestSubmission => {
  if (Predicate.isTagged(cause, "Expired")) return { kind: "unavailable" };

  if (Predicate.isTagged(cause, "Conflict")) return { kind: "full" };

  return {
    kind: "failed",
    message: Predicate.isTagged(cause, "InvalidArgs")
      ? "Choose another display name."
      : Predicate.isTagged(cause, "RateLimited")
        ? "Too many tries. Wait a few minutes, then try again."
        : "Can't reach the server. Try again.",
  };
};

export const guestGate = ({
  status,
  role,
  hasCode,
  opened,
  confirmed,
  submitting,
}: {
  readonly status: "loading" | "signedIn" | "signedOut";
  readonly role: "guest" | "household" | "loading";
  readonly hasCode: boolean;
  readonly opened: boolean;
  readonly confirmed: boolean;
  readonly submitting: boolean;
}): "loading" | "resume" | "unavailable" | "confirm" | "name" => {
  if (status === "loading" || (status === "signedIn" && role === "loading")) return "loading";

  if (status === "signedIn" && role === "guest" && (!hasCode || opened)) return "resume";

  if (!hasCode) return "unavailable";

  if (status === "signedIn" && !confirmed && !submitting) return "confirm";

  return "name";
};
