import { usePlatform } from "@media/sdk/react";
import { Badge } from "@media/ui/components/badge";
import { ProfileTile } from "@media/ui/components/profile-tile";
import { FieldError } from "@media/ui/components/text-field";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { Lede } from "@/components/auth-page";
import { describeFailure } from "@/lib/failure";
import { useAccountActions, useDevice } from "@/session/account";
import type { SharedPicker, SharedTile } from "@/session/platform-types";

import { useAction } from "./people/action";
import type { ActionStatus } from "./people/action";
import { approvalPhase, expiryOf, useClock } from "./people/approval";
import type { ApprovalPhase, Ask } from "./people/approval";
import { AskStatus } from "./people/ask-status";
import { PICKER_GRID, PickerPage } from "./people/picker-page";

/** The kid whose tile was opened last on this device, who holds it until an adult lets them go. */
export const kidHolder = (picker: SharedPicker): SharedTile | null =>
  picker.tiles.find((tile) => tile.kid && tile.userId === picker.holder) ?? null;

/** The kid holding the device, and how asking an adult to let them leave stands. */
export interface Leave {
  readonly kid: SharedTile;
  readonly phase: ApprovalPhase;
}

/**
 * A shared device's picker: everyone who listed themselves, a lock on each locked tile, and a mark
 * on each kid. While a kid holds the device, an adult can let them leave from another device.
 */
export function SharedPickerView({
  picker,
  opening,
  leave,
  onPick,
  onAskLeave,
}: {
  readonly picker: SharedPicker;
  /** Opening an open tile. */
  readonly opening: ActionStatus;
  readonly leave: Leave | null;
  readonly onPick: (tile: SharedTile) => void;
  readonly onAskLeave: () => void;
}) {
  return (
    <PickerPage title="Who's here?">
      {picker.tiles.length === 0 ? (
        <Lede>No one has put themselves on shared devices yet.</Lede>
      ) : (
        <ul className={PICKER_GRID}>
          {picker.tiles.map((tile) => {
            const locked = tile.lock.state === "locked";

            return (
              <li key={tile.userId} className="flex flex-col items-center gap-1">
                <ProfileTile
                  name={tile.username}
                  locked={locked}
                  disabled={opening.kind === "pending"}
                  aria-label={[tile.username, tile.kid ? "kid" : null, locked ? "locked" : null]
                    .filter((part) => part !== null)
                    .join(", ")}
                  onClick={() => onPick(tile)}
                />
                {tile.kid ? <Badge aria-hidden>Kid</Badge> : null}
              </li>
            );
          })}
        </ul>
      )}
      {opening.kind === "failed" ? (
        <div role="alert">
          <FieldError className="pt-0">{opening.message}</FieldError>
        </div>
      ) : null}
      {leave === null ? null : (
        <section aria-label="Leave" className="flex flex-col gap-3 md:items-center">
          <Lede>{`${leave.kid.username} is using this device. An adult can let them leave.`}</Lede>
          <AskStatus
            phase={leave.phase}
            copy={{
              ask: "Ask an adult",
              waiting: "Waiting for an adult to answer on another device.",
              approved: "An adult said yes.",
              denied: "An adult said no.",
            }}
            onAsk={onAskLeave}
          />
        </section>
      )}
    </PickerPage>
  );
}

/** A shared device's picker: everyone listed, with locks. */
export function SharedPickerScreen({ picker }: { readonly picker: SharedPicker }) {
  const platform = usePlatform();
  const device = useDevice()?.code ?? null;
  const { openTile } = useAccountActions();
  const navigate = useNavigate();
  const opening = useAction(openTile);
  const [ask, setAsk] = useState<Ask>({ kind: "idle" });
  const kid = kidHolder(picker);
  const approval = picker.approval?.intent === "leave" ? picker.approval : null;
  const now = useClock(expiryOf(ask, approval));

  const askLeave = async (): Promise<void> => {
    setAsk({ kind: "asking" });

    try {
      if (device === null) throw new Error("This browser isn't registered as a device.");

      const { approvalId, expiresAt } = await platform.core.devices.approvals.request({
        device,
        ask: { intent: "leave" },
      });

      setAsk({ kind: "sent", approvalId, expiresAt });
    } catch (cause) {
      setAsk({ kind: "failed", message: describeFailure(cause) });
    }
  };

  const pick = (tile: SharedTile): void => {
    if (tile.lock.state === "locked") {
      void navigate({ to: "/tile/$userId", params: { userId: tile.userId } });

      return;
    }

    void opening.run(tile.userId);
  };

  return (
    <SharedPickerView
      picker={picker}
      opening={opening.status}
      leave={kid === null ? null : { kid, phase: approvalPhase(ask, approval, now) }}
      onPick={pick}
      onAskLeave={() => void askLeave()}
    />
  );
}
