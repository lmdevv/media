import { cn } from "@media/ui/lib/utils";
import { MinusIcon, PlusIcon } from "lucide-react";
import { useId, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";

import { Keycaps } from "./keycap";

function StepButton({
  label,
  keys,
  disabled,
  onClick,
  children,
}: {
  readonly label: string;
  readonly keys: ReadonlyArray<string>;
  readonly disabled: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-keyshortcuts={keys.length === 0 ? undefined : keys.join("+")}
      disabled={disabled}
      onClick={onClick}
      className="flex h-8 shrink-0 cursor-pointer items-center gap-1 rounded-inner bg-text/6 px-1.5 text-text transition-colors hover:bg-text/10 disabled:cursor-default disabled:opacity-disabled disabled:hover:bg-text/6 [&_svg]:size-4"
    >
      {children}
      <Keycaps keys={keys} />
    </button>
  );
}

/**
 * The subtitle delay under the subtitle choices: Earlier and Later (with their keys), the delay in
 * seconds, which takes a typed entry, and Reset. Where the delay cannot apply, every control is
 * disabled and `unavailable` says why. Presentational: the player owns the delay and its steps.
 *
 * @param value - The delay as shown, such as `+0.5` or `0.0`.
 * @param onEntry - A typed entry, on Enter or leaving the field; one the player cannot read leaves
 *   `value` as it was.
 */
export function SubtitleDelay({
  value,
  unavailable,
  resettable,
  earlierKeys,
  laterKeys,
  onEarlier,
  onLater,
  onReset,
  onEntry,
  className,
}: {
  readonly value: string;
  /** Why the delay cannot apply now, such as `Subtitles are off`; adjustable when undefined. */
  readonly unavailable?: string | undefined;
  /** Whether Reset has a delay to clear. */
  readonly resettable: boolean;
  readonly earlierKeys: ReadonlyArray<string>;
  readonly laterKeys: ReadonlyArray<string>;
  readonly onEarlier: () => void;
  readonly onLater: () => void;
  readonly onReset: () => void;
  readonly onEntry: (text: string) => void;
  readonly className?: string;
}) {
  const reasonId = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const disabled = unavailable !== undefined;
  const [wasDisabled, setWasDisabled] = useState(disabled);

  if (disabled !== wasDisabled) {
    setWasDisabled(disabled);

    if (disabled) setDraft(null);
  }

  const typed = disabled ? null : draft;

  const commit = (): void => {
    if (typed === null) return;
    setDraft(null);

    if (typed !== value) onEntry(typed);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Enter") commit();
    else if (event.key === "Escape") setDraft(null);
  };

  return (
    <div
      role="group"
      aria-label="Subtitle delay"
      aria-describedby={disabled ? reasonId : undefined}
      data-slot="subtitle-delay"
      className={cn(
        "flex shrink-0 flex-col gap-2 border-t border-hairline px-5 pt-3 pb-5",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span
          aria-hidden
          className="font-sans text-caption/caption font-medium tracking-caps text-text-muted uppercase"
        >
          Delay
        </span>
        <button
          type="button"
          disabled={disabled || !resettable}
          onClick={onReset}
          className="cursor-pointer font-sans text-caption/caption font-medium text-text-muted transition-colors hover:text-text disabled:cursor-default disabled:opacity-disabled disabled:hover:text-text-muted"
        >
          Reset
        </button>
      </div>
      <div className="flex items-center gap-2">
        <StepButton label="Earlier" keys={earlierKeys} disabled={disabled} onClick={onEarlier}>
          <MinusIcon strokeWidth={2} aria-hidden />
        </StepButton>
        <label className="flex h-8 min-w-0 flex-1 items-center justify-center gap-0.5 rounded-inner bg-text/6 px-2 font-mono text-label/label text-text has-disabled:opacity-disabled has-focus-visible:ring-2 has-focus-visible:ring-accent">
          <input
            type="text"
            inputMode="decimal"
            aria-label="Subtitle delay in seconds"
            disabled={disabled}
            value={typed ?? value}
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => setDraft(event.currentTarget.value)}
            onKeyDown={onKeyDown}
            onBlur={commit}
            className="w-0 min-w-0 flex-1 bg-transparent text-right tabular-nums outline-none"
          />
          <span aria-hidden className="text-text-muted">
            s
          </span>
        </label>
        <StepButton label="Later" keys={laterKeys} disabled={disabled} onClick={onLater}>
          <PlusIcon strokeWidth={2} aria-hidden />
        </StepButton>
      </div>
      {disabled ? (
        <p id={reasonId} className="font-sans text-caption/caption text-text-muted">
          {unavailable}
        </p>
      ) : null}
    </div>
  );
}
