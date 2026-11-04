import { cn } from "@media/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import type { LinkProps } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { useScopes } from "@/session/viewer";

interface NavEntry {
  readonly to: NonNullable<LinkProps["to"]>;
  readonly label: string;
}

const YOU: ReadonlyArray<NavEntry> = [
  { to: "/settings/account", label: "Account" },
  { to: "/profiles", label: "Profiles" },
  { to: "/settings/devices", label: "Devices" },
  { to: "/settings/api-keys", label: "API keys" },
];

const MANAGE: ReadonlyArray<NavEntry> = [{ to: "/admin/libraries", label: "Libraries" }];

const ADMIN: ReadonlyArray<NavEntry> = [
  { to: "/admin/users", label: "Users" },
  { to: "/admin/migration", label: "Migration" },
  { to: "/admin/backups", label: "Backups" },
];

const SERVER: NavEntry = { to: "/admin/server", label: "Server" };

/** A small-caps label over a group of settings links or table columns. */
export function Eyebrow({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <span
      className={cn(
        "font-sans text-micro/caption font-semibold tracking-eyebrow text-text-muted uppercase",
        className,
      )}
    >
      {children}
    </span>
  );
}

function NavLink({ entry }: { readonly entry: NavEntry }) {
  return (
    <Link
      to={entry.to}
      className="flex h-8 shrink-0 items-center rounded-control px-2.5 font-sans text-label/label font-medium whitespace-nowrap text-text-muted transition-colors hover:text-text"
      activeProps={{
        className: "bg-surface-raised font-semibold text-text",
        "aria-current": "page",
      }}
    >
      {entry.label}
    </Link>
  );
}

function SettingsNav({ className }: { readonly className?: string }) {
  const scopes = useScopes();
  const manage = scopes.has("manage");
  const admin = scopes.has("admin");

  const server: ReadonlyArray<NavEntry> = [
    ...(manage ? MANAGE : []),
    ...(admin ? ADMIN : []),
    ...(manage || admin ? [SERVER] : []),
  ];

  return (
    <nav aria-label="Settings" className={cn("flex gap-0.5", className)}>
      <Eyebrow className="hidden px-2.5 pt-1.5 pb-2 md:block">You</Eyebrow>
      {YOU.map((entry) => (
        <NavLink key={entry.to} entry={entry} />
      ))}
      {server.length === 0 ? null : (
        <>
          <Eyebrow className="hidden px-2.5 pt-6 pb-2 md:block">Admin</Eyebrow>
          {server.map((entry) => (
            <NavLink key={entry.to} entry={entry} />
          ))}
        </>
      )}
    </nav>
  );
}

/**
 * The frame every settings, admin, and migration screen shares: the section list on the left at
 * `md` and up, a scrolling row of sections on phones, and the screen beside it.
 */
export function SettingsFrame({ children }: { readonly children: ReactNode }) {
  return (
    <div className="px-4 md:px-16">
      <div className="mx-auto flex max-w-content flex-col gap-6 pt-4 md:flex-row md:gap-12 md:pt-8">
        <SettingsNav className="scrollbar-none -mx-4 overflow-x-auto px-4 md:mx-0 md:w-52 md:shrink-0 md:flex-col md:overflow-visible md:px-0" />
        <div className="flex min-w-0 flex-1 flex-col gap-6 md:max-w-250">{children}</div>
      </div>
    </div>
  );
}
