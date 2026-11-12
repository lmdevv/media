import { usePlatform } from "@media/sdk/react";
import { Avatar } from "@media/ui/components/avatar";
import { Button } from "@media/ui/components/button";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";

import { AuthPage, Lede, PageTitle, PasswordField } from "@/components/auth-page";
import { SelectField } from "@/components/admin/parts";
import { describeFailure } from "@media/ui/lib/failure";
import { useAccountActions, useDevice } from "@/session/account";
import { nameOf } from "@/session/me";
import type { Approval, SharedPicker, SharedTile, TileProof } from "@/session/platform-types";

import { useAction } from "./people/action";
import type { ActionStatus } from "./people/action";
import { approvalPhase, expiryOf, useClock } from "./people/approval";
import type { ApprovalPhase, Ask } from "./people/approval";
import { AskStatus } from "./people/ask-status";
import { UNLOCK_CODE, codeDigits, isUnlockCode } from "./people/unlock-code";

type Locked = Extract<SharedTile["lock"], { readonly state: "locked" }>;

type UserId = SharedTile["userId"];

/** A typed proof: the prover's unlock code, or their password. */
export type Method = "code" | "password";

/**
 * Whose password or code can open `tile`: the person themself when the lock allows it, then each
 * listed adult when it allows an adult's. The picker lists only people on shared devices, so an
 * admin who is not listed cannot vouch from here.
 */
export const proversOf = (
  picker: SharedPicker,
  tile: SharedTile,
  lock: Locked,
): ReadonlyArray<SharedTile> => [
  ...(lock.opensWith === "adult" ? [] : [tile]),
  ...(lock.opensWith === "self"
    ? []
    : picker.tiles.filter((other) => !other.kid && other.userId !== tile.userId)),
];

/** The method to show: the chosen one while the prover's code is ready, else the code first. */
export const methodFor = (prover: SharedTile, chosen: Method | null): Method =>
  prover.code === "ready" ? (chosen ?? "code") : "password";

const WHO_OPENS = {
  self: (name: string) => `Only ${name} can open this tile.`,
  adult: (name: string) => `An adult opens this tile for ${name}.`,
  "self-or-adult": (name: string) => `${name} or an adult can open this tile.`,
} as const satisfies { readonly [O in Locked["opensWith"]]: (name: string) => string };

/** A proof typed on this device: whose, which kind, and how sending it went. */
export interface Typed {
  /** Everyone whose proof opens the tile. */
  readonly provers: ReadonlyArray<SharedTile>;
  readonly prover: SharedTile;
  readonly method: Method;
  readonly unlocking: ActionStatus;
}

function ProofForm({
  typed,
  busy,
  onProver,
  onMethod,
  onUnlock,
}: {
  readonly typed: Typed;
  readonly busy: boolean;
  readonly onProver: (userId: UserId) => void;
  readonly onMethod: (method: Method) => void;
  readonly onUnlock: (secret: string) => void;
}) {
  const { provers, prover, method, unlocking } = typed;
  const [secret, setSecret] = useState("");
  const ready = method === "code" ? isUnlockCode(secret) : secret !== "";
  const error = unlocking.kind === "failed" ? unlocking.message : undefined;

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();

    if (ready && !busy) onUnlock(secret);
  };

  return (
    <form className="flex flex-col gap-6" onSubmit={submit}>
      {provers.length > 1 ? (
        <SelectField
          label="Who's unlocking"
          value={prover.userId}
          options={provers.map((each) => ({ value: each.userId, label: nameOf(each) }))}
          disabled={busy}
          onChange={onProver}
        />
      ) : null}
      <div className="flex flex-col gap-2">
        {method === "code" ? (
          <PasswordField
            label={`${nameOf(prover)}'s unlock code`}
            name="code"
            inputMode="numeric"
            autoComplete="off"
            minLength={UNLOCK_CODE.min}
            maxLength={UNLOCK_CODE.max}
            value={secret}
            error={error}
            onChange={(event) => setSecret(codeDigits(event.target.value))}
          />
        ) : (
          <PasswordField
            label={`${nameOf(prover)}'s password`}
            name="password"
            autoComplete="off"
            value={secret}
            error={error}
            onChange={(event) => setSecret(event.target.value)}
          />
        )}
        {prover.code === "off" ? (
          <p className="text-label/label text-text-muted">
            {`${nameOf(prover)}'s unlock code is off on this device after 5 wrong tries. Typing the password turns it back on.`}
          </p>
        ) : null}
        {prover.code === "ready" ? (
          <button
            type="button"
            className="cursor-pointer self-start rounded-bar text-label/label font-medium text-text-muted hover:text-text"
            onClick={() => onMethod(method === "code" ? "password" : "code")}
          >
            {method === "code" ? "Use the password" : "Use the unlock code"}
          </button>
        ) : null}
      </div>
      <Button type="submit" size="lg" className="w-full" disabled={!ready || busy}>
        Unlock
      </Button>
    </form>
  );
}

/**
 * The lock screen of one locked tile on a shared device: a password or unlock code typed here, by
 * the person or an adult as the lock allows, or an approval asked of the person's other devices.
 *
 * @param typed - The typed proof; null when the lock takes an adult's and no adult is listed.
 * @param ask - Asking on another device; null when only an adult may open the tile.
 */
export function TileLockView({
  tile,
  lock,
  typed,
  ask,
  onProver,
  onMethod,
  onUnlock,
  onAsk,
  onBack,
}: {
  readonly tile: SharedTile;
  readonly lock: Locked;
  readonly typed: Typed | null;
  readonly ask: ApprovalPhase | null;
  readonly onProver: (userId: UserId) => void;
  readonly onMethod: (method: Method) => void;
  readonly onUnlock: (secret: string) => void;
  readonly onAsk: () => void;
  readonly onBack: () => void;
}) {
  const busy = typed?.unlocking.kind === "pending" || ask?.kind === "approved";

  return (
    <AuthPage>
      <div className="flex flex-col items-center gap-5 text-center">
        <Avatar name={nameOf(tile)} size="md" />
        <div className="flex flex-col gap-2">
          <PageTitle>{`Unlock ${nameOf(tile)}`}</PageTitle>
          <Lede>{WHO_OPENS[lock.opensWith](nameOf(tile))}</Lede>
        </div>
      </div>
      {typed === null ? (
        <Lede>No adult is on shared devices to unlock it.</Lede>
      ) : (
        <ProofForm
          key={`${typed.prover.userId}:${typed.method}`}
          typed={typed}
          busy={busy}
          onProver={onProver}
          onMethod={onMethod}
          onUnlock={onUnlock}
        />
      )}
      {ask === null ? null : (
        <AskStatus
          phase={ask}
          copy={{
            ask: "Ask on another device",
            waiting: `Approve on a device where ${nameOf(tile)} is signed in.`,
            approved: "Approved. Opening…",
            denied: "The request was turned down.",
          }}
          onAsk={onAsk}
        />
      )}
      <Button variant="ghost" size="md" className="self-start" onClick={onBack}>
        Choose someone else
      </Button>
    </AuthPage>
  );
}

const proofOf = (prover: SharedTile, method: Method, secret: string): TileProof =>
  method === "code"
    ? { kind: "code", by: prover.userId, code: secret }
    : { kind: "password", by: prover.userId, password: secret };

/** A locked tile: a password, an unlock code, or an approval opens it. */
export function TileLockScreen({
  picker,
  tile,
  approval,
}: {
  readonly picker: SharedPicker;
  readonly tile: SharedTile;
  readonly approval: Approval | null;
}) {
  if (tile.lock.state === "open") return null;

  return <TileLock picker={picker} tile={tile} lock={tile.lock} approval={approval} />;
}

function TileLock({
  picker,
  tile,
  lock,
  approval,
}: {
  readonly picker: SharedPicker;
  readonly tile: SharedTile;
  readonly lock: Locked;
  readonly approval: Approval | null;
}) {
  const platform = usePlatform();
  const device = useDevice()?.code ?? null;
  const { openTile } = useAccountActions();
  const navigate = useNavigate();
  const [chosen, setChosen] = useState<UserId | null>(null);
  const [method, setMethod] = useState<Method | null>(null);
  const [ask, setAsk] = useState<Ask>({ kind: "idle" });
  const now = useClock(expiryOf(ask, approval));
  const redeemed = useRef<string | null>(null);

  const provers = proversOf(picker, tile, lock);
  const prover = provers.find((each) => each.userId === chosen) ?? provers[0] ?? null;

  const unlocking = useAction((proof: TileProof) => openTile(tile.userId, proof));
  const phase = lock.opensWith === "adult" ? null : approvalPhase(ask, approval, now);
  const approvedId = phase?.kind === "approved" ? phase.approvalId : null;

  useEffect(() => {
    if (approvedId === null || redeemed.current === approvedId) return;

    redeemed.current = approvedId;

    openTile(tile.userId, { kind: "approval", approvalId: approvedId }).catch((cause: unknown) => {
      redeemed.current = null;
      setAsk({ kind: "failed", message: describeFailure(cause) });
    });
  }, [approvedId, openTile, tile.userId]);

  const askOpen = async (): Promise<void> => {
    setAsk({ kind: "asking" });

    try {
      if (device === null) throw new Error("This browser isn't registered as a device.");

      const { approvalId, expiresAt } = await platform.core.devices.approvals.request({
        device,
        ask: { intent: "open", userId: tile.userId },
      });

      setAsk({ kind: "sent", approvalId, expiresAt });
    } catch (cause) {
      setAsk({ kind: "failed", message: describeFailure(cause) });
    }
  };

  const typed: Typed | null =
    prover === null
      ? null
      : { provers, prover, method: methodFor(prover, method), unlocking: unlocking.status };

  return (
    <TileLockView
      tile={tile}
      lock={lock}
      typed={typed}
      ask={phase}
      onProver={(userId) => {
        setChosen(userId);
        setMethod(null);
        unlocking.reset();
      }}
      onMethod={(next) => {
        setMethod(next);
        unlocking.reset();
      }}
      onUnlock={(secret) => {
        if (typed !== null) void unlocking.run(proofOf(typed.prover, typed.method, secret));
      }}
      onAsk={() => void askOpen()}
      onBack={() => void navigate({ to: "/" })}
    />
  );
}
