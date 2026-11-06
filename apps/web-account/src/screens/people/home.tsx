import { buttonVariants } from "@media/ui/lib/button-variants";
import { Link } from "@tanstack/react-router";
import type { LinkProps } from "@tanstack/react-router";
import { FilmIcon, MusicIcon } from "lucide-react";

import type { Me } from "@/session/platform-types";

/** The products, each its own client on this origin that a full page load opens (ADR 0020). */
const PRODUCTS = [
  { href: "/movies", label: "Movies", Icon: FilmIcon },
  { href: "/music", label: "Music", Icon: MusicIcon },
] as const;

interface Destination {
  readonly to: NonNullable<LinkProps["to"]>;
  readonly label: string;
}

/**
 * Where a person goes besides the products. A tile session on a shared device cannot change an
 * account, so it only goes back to the picker.
 */
const destinationsOf = (me: Me): ReadonlyArray<Destination> => {
  if (me.kind === "tile") return [{ to: "/", label: "Switch person" }];

  return [
    { to: "/settings", label: "Settings" },
    ...(me.scopes.includes("admin") ? [{ to: "/admin", label: "Admin" } as const] : []),
  ];
};

/** The signed-in home: a greeting, the two products, and where else this session may go. */
export function HomeView({ me }: { readonly me: Me }) {
  return (
    <div className="px-4 md:px-16">
      <div className="mx-auto flex max-w-content flex-col gap-8 pt-8 md:gap-12 md:pt-16">
        <h1 className="text-title/title font-bold tracking-display text-text md:text-display/display">
          {`Hi, ${me.username}.`}
        </h1>
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:gap-6">
          {PRODUCTS.map(({ href, label, Icon }) => (
            <li key={href}>
              <a
                href={href}
                className="flex h-40 flex-col justify-between rounded-card bg-surface-raised p-6 text-text transition-colors hover:bg-text/10 md:h-56 md:p-8"
              >
                <Icon className="size-8 text-accent" strokeWidth={1.75} aria-hidden />
                <span className="text-title/title font-bold tracking-display">{label}</span>
              </a>
            </li>
          ))}
        </ul>
        <nav aria-label="Account" className="flex flex-wrap gap-2">
          {destinationsOf(me).map((destination) => (
            <Link
              key={destination.to}
              to={destination.to}
              className={buttonVariants({ variant: "ghost", size: "md" })}
            >
              {destination.label}
            </Link>
          ))}
        </nav>
      </div>
    </div>
  );
}
