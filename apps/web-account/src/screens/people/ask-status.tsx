import { Button } from "@media/ui/components/button";
import { Spinner } from "@media/ui/components/spinner";
import { FieldError } from "@media/ui/components/text-field";
import { Match } from "effect";
import type { ReactNode } from "react";

import type { ApprovalPhase } from "./approval";

/** What an ask says at each phase, for one kind of approval. */
export interface AskCopy {
  /** The button that sends the ask, such as `Ask an adult`. */
  readonly ask: string;
  readonly waiting: string;
  readonly approved: string;
  readonly denied: string;
}

function Waiting({ children }: { readonly children: string }) {
  return (
    <p role="status" className="flex items-center gap-2 text-body/body text-text-muted">
      <Spinner />
      {children}
    </p>
  );
}

/**
 * An approval asked from another device: the button that asks, then waiting, then the answer. A
 * refusal, an expired ask, or a failed one offers to ask again.
 */
export function AskStatus({
  phase,
  copy,
  onAsk,
}: {
  readonly phase: ApprovalPhase;
  readonly copy: AskCopy;
  readonly onAsk: () => void;
}) {
  const again = (line: ReactNode) => (
    <div className="flex flex-col items-start gap-3">
      {line}
      <Button variant="ghost" size="md" onClick={onAsk}>
        Ask again
      </Button>
    </div>
  );

  return Match.value(phase).pipe(
    Match.discriminatorsExhaustive("kind")({
      idle: () => (
        <Button variant="ghost" size="md" onClick={onAsk}>
          {copy.ask}
        </Button>
      ),
      asking: () => (
        <Button variant="ghost" size="md" disabled>
          {copy.ask}
        </Button>
      ),
      waiting: () => <Waiting>{copy.waiting}</Waiting>,
      approved: () => <Waiting>{copy.approved}</Waiting>,
      denied: () => again(<p className="text-body/body text-text">{copy.denied}</p>),
      expired: () => again(<p className="text-body/body text-text">No one answered in time.</p>),
      failed: ({ message }) =>
        again(
          <div role="alert">
            <FieldError className="pt-0">{message}</FieldError>
          </div>,
        ),
    }),
  );
}
