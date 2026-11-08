import { usePlatform, usePlatformQuery } from "@media/sdk/react";
import { Button } from "@media/ui/components/button";
import { TopBar, TopBarLink } from "@media/ui/components/top-bar";
import { Wordmark } from "@media/ui/components/wordmark";
import { cn } from "@media/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import type { LinkProps } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";
import { Fragment, useState } from "react";
import type { ReactNode } from "react";
import { toast } from "sonner";

import { describeFailure } from "@/lib/failure";
import { useAccountActions } from "@/session/account";
import { useMe } from "@/session/me";

/** The products this account opens, each its own client on this origin (ADR 0020). */
const PRODUCTS = [
  { href: "/movies", label: "Movies" },
  { href: "/music", label: "Music" },
] as const;

/**
 * The approvals this person can answer now, such as their own locked tile on a shared device. They
 * arrive only where an app is open (ADR 0006), so every signed-in page shows them.
 */
function Approvals() {
  const platform = usePlatform();
  const pending = usePlatformQuery(platform.core.devices.approvals.pending);
  const [busy, setBusy] = useState<string | null>(null);

  if (pending.status !== "success" || pending.data.length === 0) return null;

  const answer = async (approvalId: string, approve: boolean): Promise<void> => {
    setBusy(approvalId);

    try {
      const approvals = platform.core.devices.approvals;
      const target = pending.data.find((each) => each.approvalId === approvalId);

      if (target === undefined) return;

      await (approve
        ? approvals.approve({ approvalId: target.approvalId })
        : approvals.deny({ approvalId: target.approvalId }));
    } catch (cause) {
      toast.error(describeFailure(cause));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section
      aria-label="Approvals"
      className="mx-auto flex w-full max-w-content flex-col gap-2 px-4 pt-4 md:px-16"
    >
      {pending.data.map((approval) => (
        <div
          key={approval.approvalId}
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-card bg-surface-raised px-5 py-4"
        >
          <p className="text-body/body text-text">
            {approval.intent === "open"
              ? `${approval.deviceName} asks to open ${approval.username}'s tile.`
              : `${approval.deviceName} asks to let ${approval.username} leave their tile.`}
          </p>
          <div className="flex gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={busy !== null}
              onClick={() => void answer(approval.approvalId, false)}
            >
              Deny
            </Button>
            <Button
              size="sm"
              disabled={busy !== null}
              onClick={() => void answer(approval.approvalId, true)}
            >
              Approve
            </Button>
          </div>
        </div>
      ))}
    </section>
  );
}

/** Every signed-in page: the top bar with the products and the person, and the approvals. */
export function Shell({ children }: { readonly children: ReactNode }) {
  const me = useMe();
  const { signOut } = useAccountActions();
  const [leaving, setLeaving] = useState(false);

  const leave = async (): Promise<void> => {
    setLeaving(true);

    try {
      await signOut();
    } catch (cause) {
      toast.error(describeFailure(cause));
      setLeaving(false);
    }
  };

  return (
    <div className="flex min-h-svh flex-col bg-page font-sans text-text">
      <div className="px-4 md:px-16">
        <TopBar
          className="mx-auto max-w-content"
          brand={
            <Link to="/home" aria-label="[media] home" className="rounded-bar">
              <Wordmark product="media" />
            </Link>
          }
          nav={PRODUCTS.map((product) => (
            <TopBarLink key={product.href} href={product.href} className="max-md:hidden">
              {product.label}
            </TopBarLink>
          ))}
          actions={
            <>
              <TopBarLink render={<span />}>{me.username}</TopBarLink>
              <Button variant="ghost" size="xs" disabled={leaving} onClick={() => void leave()}>
                Sign out
              </Button>
            </>
          }
        />
      </div>
      {me.scopes.includes("account") ? <Approvals /> : null}
      <main className="flex grow flex-col pb-16">{children}</main>
    </div>
  );
}

interface NavEntry {
  readonly to: NonNullable<LinkProps["to"]>;
  readonly label: string;
}

const YOU: ReadonlyArray<NavEntry> = [
  { to: "/settings", label: "Settings" },
  { to: "/device", label: "Approve a device" },
];

const ADMIN: ReadonlyArray<NavEntry> = [
  { to: "/admin", label: "Users" },
  { to: "/admin/groups", label: "Groups" },
  { to: "/admin/libraries", label: "Libraries" },
  { to: "/admin/devices", label: "Devices" },
  { to: "/admin/guests", label: "Guests" },
];

/** A small-caps label over a group of links or table columns. */
function Eyebrow({
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
      activeOptions={{ exact: true }}
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

/**
 * The frame of the settings and admin screens inside the {@link Shell}: the section list on the
 * left at `md` and up, a scrolling row of sections on phones, and the screen beside it. Admin
 * sections show only to an admin.
 */
export function SettingsFrame({ children }: { readonly children: ReactNode }) {
  const me = useMe();

  return (
    <Shell>
      <div className="px-4 md:px-16">
        <div className="mx-auto flex max-w-content flex-col gap-6 pt-4 md:flex-row md:gap-12 md:pt-8">
          <nav
            aria-label="Settings"
            className="scrollbar-none -mx-4 flex gap-0.5 overflow-x-auto px-4 md:mx-0 md:w-52 md:shrink-0 md:flex-col md:overflow-visible md:px-0"
          >
            <Eyebrow className="hidden px-2.5 pt-1.5 pb-2 md:block">You</Eyebrow>
            {YOU.map((entry) => (
              <NavLink key={entry.to} entry={entry} />
            ))}
            {me.scopes.includes("admin") ? (
              <>
                <Eyebrow className="hidden px-2.5 pt-6 pb-2 md:block">Admin</Eyebrow>
                {ADMIN.map((entry) => (
                  <NavLink key={entry.to} entry={entry} />
                ))}
              </>
            ) : null}
          </nav>
          <div className="flex min-w-0 flex-1 flex-col gap-6 md:max-w-250">{children}</div>
        </div>
      </div>
    </Shell>
  );
}

/**
 * A settings screen's heading: an optional breadcrumb, the title, an optional mono line of facts,
 * and actions on the right.
 */
export function PageHeader({
  title,
  crumbs,
  facts,
  actions,
}: {
  readonly title: string;
  readonly crumbs?: ReadonlyArray<ReactNode>;
  readonly facts?: ReactNode;
  readonly actions?: ReactNode;
}) {
  return (
    <header
      className={cn(
        "flex flex-wrap justify-between gap-x-6 gap-y-4",
        crumbs === undefined && facts === undefined ? "items-center" : "items-end",
      )}
    >
      <div className="flex min-w-0 flex-col gap-1.5">
        {crumbs === undefined ? null : (
          <nav aria-label="Breadcrumb" className="flex items-center gap-1.5">
            {crumbs.map((crumb, index) => (
              <Fragment key={index}>
                {crumb}
                <ChevronRightIcon
                  className="size-3 text-text-muted"
                  strokeWidth={1.75}
                  aria-hidden
                />
              </Fragment>
            ))}
          </nav>
        )}
        <h1 className="font-sans text-title/title font-bold tracking-display text-text">{title}</h1>
        {facts === undefined ? null : (
          <p className="truncate font-mono text-caption/label text-text-muted">{facts}</p>
        )}
      </div>
      {actions === undefined ? null : (
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
      )}
    </header>
  );
}
