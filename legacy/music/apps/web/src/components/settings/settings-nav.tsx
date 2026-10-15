import { can } from "@music/commands/permissions";
import { useRead } from "@music/sdk/react";
import { cn } from "@music/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import type { LinkProps } from "@tanstack/react-router";

type SettingsPath = NonNullable<LinkProps["to"]>;

const YOU: ReadonlyArray<{ readonly to: SettingsPath; readonly label: string }> = [
  { to: "/settings/account", label: "Account" },
  { to: "/settings/playback", label: "Playback" },
];

const KEYS = { to: "/settings/keys", label: "API keys" } as const;

const ADMIN: ReadonlyArray<{ readonly to: SettingsPath; readonly label: string }> = [
  { to: "/settings/people", label: "People" },
  { to: "/settings/libraries", label: "Libraries" },
  { to: "/settings/jobs", label: "Jobs" },
];

/** The settings navigation: your sections, then the admin-only server sections. */
export function SettingsNav({ className }: { readonly className?: string }) {
  const me = useRead("account.me", {});
  const jobs = useRead("jobs.list", {});
  const busy = (jobs ?? []).some((job) => job.status === "running" || job.status === "pending");

  const item = (entry: { readonly to: SettingsPath; readonly label: string }) => (
    <Link
      key={entry.label}
      to={entry.to}
      className="flex h-11 shrink-0 items-center justify-between rounded-sm px-2.5 font-sans text-md/base text-text-muted outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-ring/50 lg:h-9 lg:text-base/sm"
      activeProps={{ className: "bg-surface font-semibold text-text", "aria-current": "page" }}
    >
      {entry.label}
      {entry.label === "Jobs" && busy ? (
        <span
          role="img"
          aria-label="A job is running"
          className="size-1.5 rounded-full bg-accent"
        />
      ) : null}
    </Link>
  );

  return (
    <nav aria-label="Settings" className={cn("flex flex-col gap-0.5", className)}>
      <span className="px-2.5 pb-1.5 font-mono text-xs/xs tracking-mono text-text-muted">YOU</span>
      {YOU.map(item)}
      {me !== undefined && can(me.role, "keys") ? item(KEYS) : null}
      {me !== undefined && can(me.role, "admin") ? (
        <>
          <span className="px-2.5 pt-4 pb-1.5 font-mono text-xs/xs tracking-mono text-text-muted">
            SERVER · ADMIN
          </span>
          {ADMIN.map(item)}
        </>
      ) : null}
    </nav>
  );
}
