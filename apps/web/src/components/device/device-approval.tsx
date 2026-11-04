import type { DeviceCodeLookup } from "@media/contracts/models/account";
import { DeviceScope } from "@media/contracts/scopes";
import { useCommand, useCommandQuery } from "@media/sdk/react";
import { Button } from "@media/ui/components/button";
import { buttonVariants } from "@media/ui/lib/button-variants";
import { CodeInput } from "@media/ui/components/code-input";
import { Spinner } from "@media/ui/components/spinner";
import { Wordmark } from "@media/ui/components/wordmark";
import { cn } from "@media/ui/lib/utils";
import { Link, useNavigate } from "@tanstack/react-router";
import { Predicate } from "effect";
import { CircleAlertIcon } from "lucide-react";
import { useState } from "react";
import type { FormEvent, ReactNode } from "react";

import { useAction } from "@/components/admin/action";
import { formatAgo, formatUntil } from "@/components/admin/format";
import { ScopeBadges } from "@/components/keys/scope-badge";
import { SCOPE_DESCRIPTIONS, sortScopes } from "@/components/keys/scopes";
import { useNow } from "@/lib/use-now";
import { useViewer } from "@/session/viewer";

import { USER_CODE_LENGTH, codeLetters, formatUserCode } from "./user-code";

const DEFAULT_SCOPES: ReadonlyArray<DeviceScope> = ["read", "play"];

/**
 * The page a device's sign-in link or QR code opens: enter or confirm the code, see which device
 * is asking, choose what it may do, and approve or deny it. Codes work once and expire after ten
 * minutes; the page says so instead of failing quietly.
 */
export function DeviceApproval({ code }: { readonly code: string | undefined }) {
  const letters = code === undefined ? "" : codeLetters(code);
  const userCode = formatUserCode(letters);

  return (
    <main className="flex min-h-svh flex-col items-center bg-page px-4 pt-10 pb-16 font-sans text-text">
      <Link to="/" aria-label="[movies] home" className="rounded-bar">
        <Wordmark className="text-wordmark/8.5" />
      </Link>
      {userCode === null ? (
        <EnterCode initial={letters} />
      ) : (
        <ApproveCode key={userCode} userCode={userCode} />
      )}
    </main>
  );
}

function Stage({
  title,
  description,
  roomy = false,
  children,
}: {
  readonly title: ReactNode;
  readonly description?: string | undefined;
  readonly roomy?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <section
      aria-labelledby="device-title"
      className={cn(
        "flex w-full max-w-dialog flex-col items-center",
        roomy ? "gap-10 pt-28" : "gap-8 pt-18",
      )}
    >
      <div className="flex flex-col items-center gap-4 text-center">
        <h1
          id="device-title"
          className="max-w-130 text-title/title font-bold tracking-display text-balance text-text"
        >
          {title}
        </h1>
        {description === undefined ? null : (
          <p className="text-body/body text-text-muted">{description}</p>
        )}
      </div>
      {children}
    </section>
  );
}

const wideButton = "h-13 w-full max-w-132 px-5.5 text-body/label";

function CodeForm({
  initial,
  title,
  description,
  problem,
  submitLabel,
}: {
  readonly initial: string;
  readonly title: string;
  readonly description?: string | undefined;
  readonly problem?: { readonly tone: "warning" | "danger"; readonly message: string };
  readonly submitLabel: string;
}) {
  const navigate = useNavigate();
  const [value, setValue] = useState(initial);
  const [edited, setEdited] = useState(false);
  const [cleared, setCleared] = useState(false);
  const complete = formatUserCode(value);

  const submit = (letters: string): void => {
    const next = formatUserCode(codeLetters(letters));

    if (next !== null) void navigate({ to: "/device", search: { code: next } });
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();

    if (problem !== undefined && !edited) {
      setValue("");
      setEdited(true);
      setCleared(true);

      return;
    }

    submit(value);
  };

  return (
    <Stage title={title} description={description} roomy={problem === undefined}>
      <form onSubmit={onSubmit} className="flex w-full flex-col items-center gap-10">
        <div className="flex flex-col items-center gap-3">
          <CodeInput
            key={cleared ? "cleared" : "first"}
            autoFocus={problem === undefined || edited}
            length={USER_CODE_LENGTH}
            groupSize={4}
            value={value}
            onValueChange={(next) => {
              setValue(codeLetters(next));
              setEdited(true);
            }}
            onComplete={(next) => {
              if (problem === undefined) submit(next);
            }}
            stale={problem?.tone === "warning" && !edited}
            invalid={problem?.tone === "danger" && !edited}
            label="Code from your device"
          />
          {problem === undefined || edited ? null : (
            <p
              className={cn(
                "flex items-center gap-2 font-mono text-label/label",
                problem.tone === "warning" ? "text-warning" : "text-danger",
              )}
            >
              <CircleAlertIcon className="size-4 shrink-0" strokeWidth={1.75} aria-hidden />
              {problem.message}
            </p>
          )}
        </div>
        <Button
          type="submit"
          className={wideButton}
          disabled={problem === undefined || edited ? complete === null : false}
        >
          {problem !== undefined && !edited ? "Try again" : submitLabel}
        </Button>
      </form>
    </Stage>
  );
}

function EnterCode({ initial }: { readonly initial: string }) {
  return (
    <CodeForm initial={initial} title="Enter the code on your device" submitLabel="Continue" />
  );
}

function ApproveCode({ userCode }: { readonly userCode: string }) {
  const lookup = useCommandQuery("deviceAuth.lookup", { userCode });

  const [decided, setDecided] = useState<
    | { readonly kind: "approved"; readonly scopes: ReadonlyArray<DeviceScope> }
    | { readonly kind: "denied" }
    | null
  >(null);

  const now = useNow(15_000);
  const letters = codeLetters(userCode);

  if (lookup.status === "loading") {
    return (
      <div className="pt-28">
        <Spinner className="size-8 text-text" label="Loading" />
      </div>
    );
  }

  if (lookup.status === "error") {
    return Predicate.isTagged(lookup.error, "NotFound") ? (
      <CodeForm
        initial={letters}
        title="That code isn’t valid"
        description="Check the code on your device and enter it again."
        problem={{ tone: "danger", message: `No device is waiting for ${userCode}` }}
        submitLabel="Continue"
      />
    ) : (
      <Stage title="Can’t check that code" description={lookup.error.message}>
        <Link to="/device" className={buttonVariants({ className: wideButton })}>
          Try again
        </Link>
      </Stage>
    );
  }

  const device = lookup.data;

  if (decided?.kind === "approved") return <Approved device={device} scopes={decided.scopes} />;

  if (decided?.kind === "denied") {
    return (
      <Stage
        title={`${device.clientName} was denied`}
        description="It can’t sign in with this code. Start again on the device to try once more."
      >
        <Link to="/" className={buttonVariants({ variant: "subtle", className: "h-11 px-6" })}>
          Go to Home
        </Link>
      </Stage>
    );
  }

  if (device.state === "expired") {
    return (
      <CodeForm
        initial={letters}
        title="That code has expired"
        description="Ask your device for a new code and enter it below."
        problem={{
          tone: "warning",
          message: `${userCode} expired ${formatAgo(device.expiresAt, now)}`,
        }}
        submitLabel="Continue"
      />
    );
  }

  if (device.state !== "pending") {
    return (
      <CodeForm
        initial={letters}
        title="That code was already used"
        description="Each code works once. Ask your device for a new one."
        problem={{
          tone: "warning",
          message: device.state === "denied" ? `${userCode} was denied` : `${userCode} is used up`,
        }}
        submitLabel="Continue"
      />
    );
  }

  return (
    <Decide
      device={device}
      now={now}
      onApproved={(scopes) => setDecided({ kind: "approved", scopes })}
      onDenied={() => setDecided({ kind: "denied" })}
    />
  );
}

function InfoRow({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="flex min-h-10 shrink-0 items-center gap-4 py-1.5">
      <dt className="w-28 shrink-0 text-label/label text-text-muted">{label}</dt>
      <dd className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-1">{children}</dd>
    </div>
  );
}

function Decide({
  device,
  now,
  onApproved,
  onDenied,
}: {
  readonly device: DeviceCodeLookup;
  readonly now: number;
  readonly onApproved: (scopes: ReadonlyArray<DeviceScope>) => void;
  readonly onDenied: () => void;
}) {
  const viewer = useViewer();
  const approve = useCommand("deviceAuth.approve");
  const deny = useCommand("deviceAuth.deny");
  const held = viewer?.scopes ?? [];
  const grantable = DeviceScope.literals.filter((scope) => held.includes(scope));
  const [chosen, setChosen] = useState<ReadonlyArray<DeviceScope>>(DEFAULT_SCOPES);
  const scopes = sortScopes(chosen.filter((scope) => grantable.includes(scope)));
  const name = viewer?.user.name ?? "you";

  const approval = useAction(
    async () => {
      await approve({ userCode: device.userCode, scopes });

      return scopes;
    },
    { onSuccess: onApproved },
  );

  const denial = useAction(() => deny({ userCode: device.userCode }), { onSuccess: onDenied });
  const busy = approval.pending || denial.pending;

  return (
    <Stage
      title={
        <>
          {device.clientName}
          <br />
          wants to sign in as {name}
        </>
      }
    >
      <dl className="flex w-full max-w-132 flex-col rounded-card bg-surface-raised px-5 py-3">
        <InfoRow label="Device">
          <span className="truncate text-body/body text-text">{device.clientName}</span>
        </InfoRow>
        <InfoRow label="Code">
          <span className="font-mono text-label/label text-text">{device.userCode}</span>
          <span className="text-label/label text-text-muted">
            expires {formatUntil(device.expiresAt, now)}
          </span>
        </InfoRow>
        <InfoRow label="Can">
          <span
            role="group"
            aria-label="What it can do"
            className="flex flex-wrap items-center gap-1.5"
          >
            {grantable.map((scope) => {
              const on = chosen.includes(scope);

              return (
                <button
                  key={scope}
                  type="button"
                  aria-pressed={on}
                  title={SCOPE_DESCRIPTIONS[scope]}
                  onClick={() =>
                    setChosen((current) =>
                      on ? current.filter((each) => each !== scope) : [...current, scope],
                    )
                  }
                  className={cn(
                    "flex h-5 cursor-pointer items-center rounded-poster border px-1.5 font-mono text-micro/3.5 transition-colors",
                    on
                      ? scope === "admin"
                        ? "border-warning/70 text-warning"
                        : "border-text/40 text-text"
                      : "border-dashed border-text-muted/60 text-text-muted line-through",
                  )}
                >
                  {scope}
                </button>
              );
            })}
          </span>
        </InfoRow>
      </dl>
      <div className="flex w-full max-w-132 items-center gap-3">
        <Button
          variant="secondary"
          className="h-13 flex-1 px-5 text-body/label"
          disabled={busy}
          onClick={() => void denial.run()}
        >
          Deny
        </Button>
        <Button
          className="h-13 flex-1 px-5.5 text-body/label"
          disabled={busy || scopes.length === 0}
          onClick={() => void approval.run()}
        >
          Approve
        </Button>
      </div>
    </Stage>
  );
}

function Approved({
  device,
  scopes,
}: {
  readonly device: DeviceCodeLookup;
  readonly scopes: ReadonlyArray<DeviceScope>;
}) {
  const viewer = useViewer();
  const name = viewer?.user.name ?? null;

  return (
    <Stage
      title={
        <>
          {device.clientName}
          <br />
          is signed in
        </>
      }
    >
      <dl className="flex w-full max-w-132 flex-col rounded-card bg-surface-raised px-5 py-3">
        <InfoRow label="Device">
          <span className="truncate text-body/body text-text">
            {name === null ? device.clientName : `${device.clientName} · signed in as ${name}`}
          </span>
        </InfoRow>
        <InfoRow label="Allowed">
          <ScopeBadges scopes={scopes} />
        </InfoRow>
      </dl>
      <Link
        to="/settings/devices"
        className={buttonVariants({ variant: "secondary", className: "h-11 px-6" })}
      >
        Manage devices
      </Link>
    </Stage>
  );
}
