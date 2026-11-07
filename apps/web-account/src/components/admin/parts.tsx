import { Button } from "@media/ui/components/button";
import { Skeleton } from "@media/ui/components/skeleton";
import { copyText } from "@media/ui/lib/secure-context";
import { cn } from "@media/ui/lib/utils";
import { CheckIcon, ChevronDownIcon, CopyIcon, TriangleAlertIcon } from "lucide-react";
import { useId, useState } from "react";
import type { ReactNode } from "react";
import { toast } from "sonner";

import type { Paged } from "./pages";

/** A titled part of an admin screen. */
export function Section({
  title,
  actions,
  children,
}: {
  readonly title: string;
  readonly actions?: ReactNode;
  readonly children: ReactNode;
}) {
  const id = useId();

  return (
    <section aria-labelledby={id} className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id={id} className="font-sans text-heading/heading font-bold tracking-tight text-text">
          {title}
        </h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

/** A muted line, such as an empty list or a fact under a heading. */
export function Muted({ children }: { readonly children: ReactNode }) {
  return <p className="font-sans text-label/label text-text-muted">{children}</p>;
}

/** A failure line with Try again. */
export function Failed({
  message,
  retry,
}: {
  readonly message: string;
  readonly retry: () => void;
}) {
  return (
    <div className="flex flex-col items-start gap-3">
      <p className="font-sans text-body/body text-text-muted">{message}</p>
      <Button variant="raised" size="xs" onClick={retry}>
        Try again
      </Button>
    </div>
  );
}

/**
 * A paginated list: a skeleton until the first page, its failure with Try again, `empty` when it
 * holds nothing, then each row and Load more while pages remain.
 */
export function PagedList<Row>({
  label,
  list,
  empty,
  rowKey,
  children,
}: {
  readonly label: string;
  readonly list: Paged<Row>;
  readonly empty: string;
  readonly rowKey: (row: Row) => string;
  readonly children: (row: Row) => ReactNode;
}) {
  if (list.status === "loading") {
    return <Skeleton aria-label={`Loading ${label}`} className="h-24 w-full rounded-control" />;
  }

  if (list.status === "failed") return <Failed message={list.message} retry={list.retry} />;

  if (list.rows.length === 0 && list.next.kind === "done") return <Muted>{empty}</Muted>;

  const { next } = list;

  return (
    <div className="flex min-w-0 flex-col">
      <ul aria-label={label} className="flex min-w-0 flex-col">
        {list.rows.map((row) => (
          <li key={rowKey(row)} className="min-w-0">
            {children(row)}
          </li>
        ))}
      </ul>
      {next.kind === "done" ? null : (
        <div className="pt-3">
          {next.kind === "failed" ? (
            <Failed message={next.message} retry={next.retry} />
          ) : (
            <Button
              variant="raised"
              size="xs"
              disabled={next.kind === "loading"}
              onClick={next.kind === "more" ? next.load : undefined}
            >
              Load more
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/** A list row: a name with facts under it, and actions that wrap below on a phone. */
export function ItemRow({
  title,
  facts,
  actions,
  children,
}: {
  readonly title: ReactNode;
  readonly facts?: ReactNode;
  readonly actions?: ReactNode;
  readonly children?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 py-3">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-1 basis-48 flex-col gap-0.5">
          <span className="truncate font-sans text-label/label font-semibold text-text">
            {title}
          </span>
          {facts === undefined ? null : (
            <span className="truncate font-mono text-caption/caption text-text-muted">{facts}</span>
          )}
        </div>
        {actions === undefined ? null : (
          <div className="flex flex-wrap items-center gap-2">{actions}</div>
        )}
      </div>
      {children}
    </div>
  );
}

/** A warning-tinted line with a triangle, such as “You won’t see this link again”. */
export function Notice({
  children,
  action,
}: {
  readonly children: ReactNode;
  readonly action?: ReactNode;
}) {
  return (
    <div
      role="note"
      className="flex flex-wrap items-center gap-3 rounded-control bg-warning/10 px-3.5 py-3"
    >
      <TriangleAlertIcon className="size-4 shrink-0 text-warning" strokeWidth={1.75} aria-hidden />
      <div className="min-w-0 flex-1 basis-48 font-sans text-label/label text-text">{children}</div>
      {action}
    </div>
  );
}

/** One option of a {@link SelectField}. */
export interface Choice<Value extends string> {
  readonly value: Value;
  readonly label: string;
}

/**
 * A labeled native select drawn as the Paper dropdown field. Native, so it opens the platform
 * picker and works with the keyboard and screen readers.
 */
export function SelectField<Value extends string>({
  label,
  value,
  options,
  onChange,
  disabled = false,
  className,
}: {
  readonly label: string;
  readonly value: Value;
  readonly options: ReadonlyArray<Choice<Value>>;
  readonly onChange: (value: Value) => void;
  readonly disabled?: boolean;
  readonly className?: string;
}) {
  const id = useId();

  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <label htmlFor={id} className="font-sans text-label/label font-medium text-text-muted">
        {label}
      </label>
      <div className="relative flex items-center">
        <select
          id={id}
          value={value}
          disabled={disabled}
          onChange={(event) => {
            const next = options.find((option) => option.value === event.target.value);

            if (next !== undefined) onChange(next.value);
          }}
          className="h-9 w-full min-w-0 cursor-pointer appearance-none rounded-control border border-hairline bg-surface pr-8 pl-3 font-sans text-label/label text-text outline-none disabled:cursor-not-allowed disabled:opacity-(--opacity-disabled)"
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <ChevronDownIcon
          className="pointer-events-none absolute right-3 size-3 text-text-muted"
          strokeWidth={1.75}
          aria-hidden
        />
      </div>
    </div>
  );
}

const COPIED_MS = 2000;

/**
 * A one-line mono value with a Copy button at its end, for a link shown once. The value is
 * selectable so it can be copied by hand when the clipboard is unavailable.
 */
function CopyField({ value, label }: { readonly value: string; readonly label: string }) {
  const [copiedAt, setCopiedAt] = useState<number | null>(null);
  const copied = copiedAt !== null;

  const copy = async (): Promise<void> => {
    try {
      await copyText(value);

      const at = Date.now();

      setCopiedAt(at);
      window.setTimeout(
        () => setCopiedAt((current) => (current === at ? null : current)),
        COPIED_MS,
      );
    } catch {
      toast.error("Couldn't copy. Select it and copy it yourself.");
    }
  };

  return (
    <div className="flex h-9 min-w-0 items-center gap-3 rounded-control border border-hairline bg-bg pr-0.5 pl-3.5">
      <output
        aria-label={label}
        className="min-w-0 flex-1 truncate font-mono text-label/label text-text select-all"
      >
        {value}
      </output>
      <button
        type="button"
        onClick={() => void copy()}
        className="flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-control bg-accent px-2.5 font-sans text-label/label font-semibold text-on-accent transition-colors hover:bg-accent-pressed"
      >
        {copied ? (
          <CheckIcon className="size-3.5" strokeWidth={2} aria-hidden />
        ) : (
          <CopyIcon className="size-3.5" strokeWidth={2} aria-hidden />
        )}
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

/** A link made once, such as an invite or a reset link: the copy field and when it stops working. */
export function OnceLink({
  label,
  url,
  expiresAt,
  onDone,
}: {
  readonly label: string;
  readonly url: string;
  readonly expiresAt: number;
  readonly onDone: () => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <span className="font-sans text-label/label font-medium text-text-muted">{label}</span>
      <CopyField value={url} label={label} />
      <Muted>{`Works until ${formatTime(expiresAt)}. It shows only this once.`}</Muted>
      <div>
        <Button variant="ghost" size="xs" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}

const DATE_TIME = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/** A moment as the admin screens write it, such as `Nov 6, 2026, 9:30 PM`. */
export const formatTime = (at: number): string => DATE_TIME.format(at);
