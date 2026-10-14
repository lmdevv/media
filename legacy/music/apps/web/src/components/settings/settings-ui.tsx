import type { ReactNode } from "react";

/** The heading, lead, and optional action at the top of a settings section. */
export function SettingsHeader({
  title,
  lead,
  action,
}: {
  readonly title: string;
  readonly lead: ReactNode;
  readonly action?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="flex max-w-dialog flex-col gap-1">
        <h2 className="font-sans text-lg/md font-semibold tracking-tight text-text">{title}</h2>
        <p className="font-sans text-base/base text-text-muted">{lead}</p>
      </div>
      {action}
    </div>
  );
}

/** A mono label beside a terminal command, used for CLI hints. */
export function TerminalHint({
  label,
  command,
}: {
  readonly label: string;
  readonly command: string;
}) {
  return (
    <div className="flex w-fit max-w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-surface px-3.5 py-2.5">
      <span className="font-mono text-xs/xs tracking-mono text-text-muted uppercase">{label}</span>
      <code className="font-mono text-sm/xs break-all text-text">{command}</code>
    </div>
  );
}

/** Shown in place of an admin section to members. */
export function AdminOnly() {
  return (
    <div className="flex flex-col items-start gap-2 rounded-lg border border-dashed border-border p-8">
      <span className="font-sans text-md/base font-semibold text-text">
        Only admins can see this
      </span>
      <span className="max-w-130 font-sans text-base/base text-text-muted">
        Ask an admin on this server if you need a change here.
      </span>
    </div>
  );
}
