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
