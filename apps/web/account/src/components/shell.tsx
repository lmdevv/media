import { usePlatform, usePlatformQuery } from "@media/sdk/react";
import { Button } from "@media/ui/components/button";
import { TopBar, TopBarLink } from "@media/ui/components/top-bar";
import { Link } from "@tanstack/react-router";
import type { LinkProps } from "@tanstack/react-router";
import { LogOutIcon } from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";
import { toast } from "sonner";

import { describeFailure } from "@media/ui/lib/failure";
import { useAccountActions } from "@/session/account";
import { nameOf, useMe } from "@/session/me";

import { Cube, CubeField, TONES } from "./cube";
import { LarWordmark } from "./lar-mark";
import { PRODUCTS, ProductCube } from "./products";

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
          className="flex flex-wrap items-center justify-between gap-3 border-b border-hairline py-4"
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

export function Shell({
  field = "page",
  children,
}: {
  readonly field?: "page" | "home";
  readonly children: ReactNode;
}) {
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
    <div className="relative isolate flex min-h-svh flex-col overflow-x-clip bg-page font-sans text-text">
      <CubeField kind={field} />
      <div className="px-4 md:px-16">
        <TopBar
          className="mx-auto h-19 max-w-content"
          brand={
            <Link to="/home" aria-label="Lar home" className="rounded-bar">
              <LarWordmark />
            </Link>
          }
          nav={PRODUCTS.map((product) => (
            <TopBarLink
              key={product.href}
              href={product.href}
              className="flex items-center gap-2.5 text-body/label font-semibold text-text max-md:hidden"
            >
              <ProductCube product={product} />
              {product.label}
            </TopBarLink>
          ))}
          actions={
            <>
              <span className="flex items-center gap-2.5 text-small/label font-medium text-text">
                <Cube faces={TONES.lit} className="size-6" />
                {nameOf(me)}
              </span>
              <button
                type="button"
                aria-label="Sign out"
                title="Sign out"
                disabled={leaving}
                onClick={() => void leave()}
                className="flex size-9 cursor-pointer items-center justify-center rounded-control text-text-muted transition-colors hover:text-text disabled:pointer-events-none disabled:opacity-(--opacity-disabled)"
              >
                <LogOutIcon className="size-4.5" strokeWidth={1.75} aria-hidden />
              </button>
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
  { to: "/devices", label: "Devices" },
  { to: "/api-keys", label: "API keys" },
  { to: "/device", label: "Approve a device" },
];

const ADMIN: ReadonlyArray<NavEntry> = [
  { to: "/admin", label: "Users" },
  { to: "/admin/groups", label: "Groups" },
  { to: "/admin/libraries", label: "Libraries" },
  { to: "/admin/jobs", label: "Jobs" },
  { to: "/admin/devices", label: "Devices" },
  { to: "/admin/guests", label: "Guests" },
  { to: "/admin/server", label: "Server" },
  { to: "/admin/backups", label: "Backups" },
];

function NavLink({ entry }: { readonly entry: NavEntry }) {
  return (
    <Link
      to={entry.to}
      activeOptions={{ exact: true }}
      className="flex h-9 shrink-0 items-center rounded-bar font-sans text-body/label font-medium whitespace-nowrap text-text-muted transition-colors hover:text-text max-md:px-2.5"
      activeProps={{ className: "font-semibold text-text", "aria-current": "page" }}
    >
      {entry.label}
    </Link>
  );
}

function NavGroup({ children }: { readonly children: ReactNode }) {
  return (
    <span className="hidden pt-5 pb-1.5 font-mono text-micro/3.5 tracking-eyebrow text-text-muted uppercase md:block">
      {children}
    </span>
  );
}

export function SettingsFrame({ children }: { readonly children: ReactNode }) {
  const me = useMe();

  return (
    <Shell>
      <div className="px-4 md:px-16">
        <div className="relative mx-auto grid max-w-content content-start gap-y-8 pt-4 md:min-h-200 md:grid-cols-[12.5rem_minmax(0,1fr)] md:gap-x-16 md:pt-0 md:[&>:not(header,nav)]:col-start-2 md:[&>:not(header,nav)]:max-w-225">
          <nav
            aria-label="Settings"
            className="scrollbar-none -mx-4 flex gap-0.5 overflow-x-auto px-4 md:absolute md:top-0 md:left-0 md:col-start-1 md:row-start-2 md:mx-0 md:w-50 md:flex-col md:gap-0 md:overflow-visible md:px-0"
          >
            <NavGroup>You</NavGroup>
            {YOU.map((entry) => (
              <NavLink key={entry.to} entry={entry} />
            ))}
            {me.scopes.includes("admin") ? (
              <>
                <NavGroup>Admin</NavGroup>
                {ADMIN.map((entry) => (
                  <NavLink key={entry.to} entry={entry} />
                ))}
              </>
            ) : null}
          </nav>
          {children}
        </div>
      </div>
    </Shell>
  );
}
