import { Button } from "@media/ui/components/button";
import { CodeInput } from "@media/ui/components/code-input";
import { Spinner } from "@media/ui/components/spinner";
import { FieldError } from "@media/ui/components/text-field";
import { cn } from "@media/ui/lib/utils";
import { Match } from "effect";
import { CircleAlertIcon } from "lucide-react";
import type { FormEvent, ReactNode } from "react";

import { USER_CODE_LENGTH } from "./user-code";

/** Why a typed code can't be approved, shown under the boxes until the person edits them. */
export interface CodeProblem {
  readonly title: string;
  /** `danger` for a code no device waits on, `warning` for one that expired or was used. */
  readonly tone: "danger" | "warning";
  readonly message: string;
}

/** A device waiting on its code, and who it would sign in as. */
interface WaitingDevice {
  readonly clientName: string;
  readonly userCode: string;
  readonly username: string;
  readonly scopes: ReadonlyArray<string>;
}

/** What the person's answer to a waiting device is doing. */
export type Answer =
  | { readonly kind: "idle" }
  | { readonly kind: "approving" }
  | { readonly kind: "denying" }
  | { readonly kind: "failed"; readonly message: string };

/** Each step of approving a device sign-in. */
export type DeviceStep =
  | { readonly kind: "enter"; readonly letters: string; readonly problem: CodeProblem | null }
  | { readonly kind: "checking" }
  | { readonly kind: "unreachable"; readonly message: string }
  | { readonly kind: "decide"; readonly device: WaitingDevice; readonly answer: Answer }
  | { readonly kind: "approved"; readonly clientName: string; readonly username: string }
  | { readonly kind: "denied"; readonly clientName: string };

/** What the person can do on each step. */
export interface DeviceActions {
  readonly onLettersChange: (letters: string) => void;
  /** Checks the typed code, once all its letters are in. */
  readonly onSubmitCode: (letters: string) => void;
  readonly onApprove: () => void;
  readonly onDeny: () => void;
  /** Checks the code again after a failure to reach the server. */
  readonly onRetry: () => void;
  /** Clears the code to approve another device. */
  readonly onStartOver: () => void;
}

/** The body of the Approve a device page for `step`, under its header. */
export function DeviceApprovalView({
  step,
  actions,
}: {
  readonly step: DeviceStep;
  readonly actions: DeviceActions;
}) {
  return Match.value(step).pipe(
    Match.discriminatorsExhaustive("kind")({
      enter: ({ letters, problem }) => (
        <EnterCode letters={letters} problem={problem} actions={actions} />
      ),
      checking: () => <Spinner className="size-6 text-text" label="Checking the code" />,
      unreachable: ({ message }) => (
        <Outcome title="Can't check that code." line={message}>
          <Button size="lg" onClick={actions.onRetry}>
            Try again
          </Button>
        </Outcome>
      ),
      decide: ({ device, answer }) => <Decide device={device} answer={answer} actions={actions} />,
      approved: ({ clientName, username }) => (
        <Outcome title={`${clientName} is signed in.`} line={`It signed in as ${username}.`}>
          <Button variant="subtle" size="lg" onClick={actions.onStartOver}>
            Approve another device
          </Button>
        </Outcome>
      ),
      denied: ({ clientName }) => (
        <Outcome
          title={`${clientName} was denied.`}
          line="It can't sign in with this code. Start again on the device to try once more."
        >
          <Button variant="subtle" size="lg" onClick={actions.onStartOver}>
            Enter another code
          </Button>
        </Outcome>
      ),
    }),
  );
}

function Outcome({
  title,
  line,
  children,
}: {
  readonly title: string;
  readonly line: string;
  readonly children: ReactNode;
}) {
  return (
    <section className="flex flex-col items-start gap-6">
      <div className="flex flex-col gap-2">
        <h2 className="text-heading/heading font-bold text-text">{title}</h2>
        <p className="text-body/body text-text-muted">{line}</p>
      </div>
      {children}
    </section>
  );
}

function EnterCode({
  letters,
  problem,
  actions,
}: {
  readonly letters: string;
  readonly problem: CodeProblem | null;
  readonly actions: DeviceActions;
}) {
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    actions.onSubmitCode(letters);
  };

  return (
    <form onSubmit={submit} className="flex flex-col items-start gap-6">
      <h2 className="text-heading/heading font-bold text-text">
        {problem?.title ?? "Enter the code your device shows."}
      </h2>
      <div className="flex flex-col gap-3">
        <CodeInput
          autoFocus
          length={USER_CODE_LENGTH}
          groupSize={4}
          value={letters}
          onValueChange={actions.onLettersChange}
          onComplete={actions.onSubmitCode}
          stale={problem?.tone === "warning"}
          invalid={problem?.tone === "danger"}
          label="Code from your device"
          className="md:max-lg:[&_input]:h-13 md:max-lg:[&_input]:w-9 md:max-lg:[&_input]:text-heading/heading"
        />
        {problem === null ? null : (
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
        size="lg"
        disabled={letters.length < USER_CODE_LENGTH || problem !== null}
      >
        Continue
      </Button>
    </form>
  );
}

function Row({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="flex min-h-10 items-center gap-4 py-1.5">
      <dt className="w-28 shrink-0 text-label/label text-text-muted">{label}</dt>
      <dd className="min-w-0 flex-1 text-body/body break-words text-text">{children}</dd>
    </div>
  );
}

function Decide({
  device,
  answer,
  actions,
}: {
  readonly device: WaitingDevice;
  readonly answer: Answer;
  readonly actions: DeviceActions;
}) {
  const busy = answer.kind === "approving" || answer.kind === "denying";

  return (
    <section className="flex flex-col gap-6">
      <h2 className="text-heading/heading font-bold text-text">
        {device.clientName} wants to sign in as {device.username}.
      </h2>
      <dl className="flex flex-col">
        <Row label="Device">{device.clientName}</Row>
        <Row label="Code">
          <span className="font-mono">{device.userCode}</span>
        </Row>
        <Row label="Can">
          <span className="font-mono text-label/label">{device.scopes.join(" · ")}</span>
        </Row>
      </dl>
      <div className="flex flex-col gap-3">
        <div className="flex gap-3">
          <Button
            variant="ghost"
            size="lg"
            className="flex-1 sm:flex-none"
            disabled={busy}
            onClick={actions.onDeny}
          >
            Deny
          </Button>
          <Button
            size="lg"
            className="flex-1 sm:flex-none"
            disabled={busy}
            onClick={actions.onApprove}
          >
            Approve
          </Button>
        </div>
        {answer.kind === "failed" ? <FieldError>{answer.message}</FieldError> : null}
      </div>
    </section>
  );
}
