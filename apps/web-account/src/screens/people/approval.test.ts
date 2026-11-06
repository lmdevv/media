import { describe, expect, it } from "vitest";

import { approvalPhase } from "./approval";
import { anApprovalId, approval, userId } from "./fixtures";

const ada = userId("ada");

const NOW = 1_000_000;

const live = { expiresAt: NOW + 60_000 };

const gone = { expiresAt: NOW };

describe("approvalPhase", () => {
  it("offers to ask when nothing was asked", () => {
    expect(approvalPhase({ kind: "idle" }, null, NOW)).toEqual({ kind: "idle" });
  });

  it("shows the ask in flight, and its failure", () => {
    expect(approvalPhase({ kind: "asking" }, null, NOW)).toEqual({ kind: "asking" });
    expect(approvalPhase({ kind: "failed", message: "No" }, null, NOW)).toEqual({
      kind: "failed",
      message: "No",
    });
  });

  it("waits after sending until the picker shows the approval", () => {
    const sent = { kind: "sent", approvalId: anApprovalId("a2") } as const;

    expect(approvalPhase(sent, null, NOW)).toEqual({ kind: "waiting" });
    expect(approvalPhase(sent, approval(ada, "approved", live), NOW)).toEqual({ kind: "waiting" });
  });

  it("follows a pending approval the picker shows, as after a reload", () => {
    expect(approvalPhase({ kind: "idle" }, approval(ada, "pending", live), NOW)).toEqual({
      kind: "waiting",
    });
  });

  it("hands back an approved or already redeemed approval to redeem", () => {
    const id = anApprovalId("a1");

    expect(approvalPhase({ kind: "idle" }, approval(ada, "approved", live), NOW)).toEqual({
      kind: "approved",
      approvalId: id,
    });
    expect(approvalPhase({ kind: "idle" }, approval(ada, "redeemed", live), NOW)).toEqual({
      kind: "approved",
      approvalId: id,
    });
  });

  it("shows a refusal", () => {
    expect(approvalPhase({ kind: "idle" }, approval(ada, "denied", live), NOW)).toEqual({
      kind: "denied",
    });
  });

  it("expires a pending or approved approval by the clock", () => {
    expect(approvalPhase({ kind: "idle" }, approval(ada, "pending", gone), NOW)).toEqual({
      kind: "expired",
    });
    expect(approvalPhase({ kind: "idle" }, approval(ada, "approved", gone), NOW)).toEqual({
      kind: "expired",
    });
  });
});
