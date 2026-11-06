import { useEffect, useState } from "react";

import type { Approval } from "@/session/platform-types";

/** What this screen did about asking: nothing yet, sending the ask, sent it, or failed to. */
export type Ask =
  | { readonly kind: "idle" }
  | { readonly kind: "asking" }
  | { readonly kind: "sent"; readonly approvalId: Approval["approvalId"] }
  | { readonly kind: "failed"; readonly message: string };

/** An ask's progress as the lock screen and the picker show it. */
export type ApprovalPhase =
  | { readonly kind: "idle" }
  | { readonly kind: "asking" }
  | { readonly kind: "waiting" }
  | { readonly kind: "approved"; readonly approvalId: Approval["approvalId"] }
  | { readonly kind: "denied" }
  | { readonly kind: "expired" }
  | { readonly kind: "failed"; readonly message: string };

/**
 * The phase from this screen's ask and the approval the device's picker shows, at `now`. The
 * picker's query does not rerun when an approval's 2 minutes end, so the clock decides expiry. A
 * redeemed approval counts as approved: redeeming it again returns the same session (ADR 0006).
 */
export const approvalPhase = (ask: Ask, approval: Approval | null, now: number): ApprovalPhase => {
  if (ask.kind === "asking") return { kind: "asking" };

  if (ask.kind === "failed") return { kind: "failed", message: ask.message };

  if (approval === null || (ask.kind === "sent" && approval.approvalId !== ask.approvalId)) {
    return ask.kind === "sent" ? { kind: "waiting" } : { kind: "idle" };
  }

  if (approval.state === "denied") return { kind: "denied" };

  if (approval.expiresAt <= now) return { kind: "expired" };

  return approval.state === "pending"
    ? { kind: "waiting" }
    : { kind: "approved", approvalId: approval.approvalId };
};

/** Timers can fire a few milliseconds early; reading the clock this much later is past expiry. */
const TIMER_SLACK_MS = 50;

/** The time now, read again when `expiresAt` passes so an expired approval shows as expired. */
export const useClock = (expiresAt: number | null): number => {
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    const wait = expiresAt === null ? null : Math.max(0, expiresAt - Date.now()) + TIMER_SLACK_MS;
    const timer = wait === null ? undefined : setTimeout(() => setNow(Date.now()), wait);

    return () => clearTimeout(timer);
  }, [expiresAt]);

  return now;
};
