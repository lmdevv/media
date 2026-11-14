import { Link } from "@tanstack/react-router";

import {
  ACCOUNT_API_KEYS,
  ACCOUNT_JOBS,
  ACCOUNT_LIBRARIES,
  ACCOUNT_PEOPLE,
} from "@/lib/account-links";
import { can } from "@/lib/permissions";
import { useMe } from "@/lib/platform";
import { cn } from "@/lib/utils";

/** A settings page in the account client at `/`, where old music's account and server settings moved. */
interface AccountPage {
  readonly href: string;
  readonly label: string;
}

const OWN = [
  { to: "/settings/account", label: "Account" },
  { to: "/settings/playback", label: "Playback" },
] as const;

const KEYS: AccountPage = { href: ACCOUNT_API_KEYS, label: "API keys" };

const ADMIN: ReadonlyArray<AccountPage> = [
  { href: ACCOUNT_PEOPLE, label: "People" },
  { href: ACCOUNT_LIBRARIES, label: "Libraries" },
  { href: ACCOUNT_JOBS, label: "Jobs" },
];

const itemClassName =
  "flex h-11 shrink-0 items-center justify-between rounded-sm px-2.5 font-sans text-md/base text-text-muted outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-ring/50 lg:h-9 lg:text-base/sm";

const account = (page: AccountPage) => (
  <a key={page.label} href={page.href} className={itemClassName}>
    {page.label}
  </a>
);

/**
 * The settings navigation: your sections, then the admin-only server sections. Account and
 * Playback are this client's own; keys and the server's sections open in the account client,
 * which keeps them for every product.
 */
export function SettingsNav({ className }: { readonly className?: string }) {
  const me = useMe();

  return (
    <nav aria-label="Settings" className={cn("flex flex-col gap-0.5", className)}>
      <span className="px-2.5 pb-1.5 font-mono text-xs/xs tracking-mono text-text-muted">YOU</span>
      {OWN.map((page) => (
        <Link
          key={page.label}
          to={page.to}
          className={itemClassName}
          activeProps={{ className: "bg-surface font-semibold text-text", "aria-current": "page" }}
        >
          {page.label}
        </Link>
      ))}
      {me !== undefined && me.role !== "guest" ? account(KEYS) : null}
      {me !== undefined && can(me.role, "admin") ? (
        <>
          <span className="px-2.5 pt-4 pb-1.5 font-mono text-xs/xs tracking-mono text-text-muted">
            SERVER · ADMIN
          </span>
          {ADMIN.map(account)}
        </>
      ) : null}
    </nav>
  );
}
