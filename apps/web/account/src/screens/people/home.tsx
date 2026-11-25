import { Link } from "@tanstack/react-router";
import type { LinkProps } from "@tanstack/react-router";
import { ArrowRightIcon, SettingsIcon, ShieldCheckIcon, UsersIcon } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { PRODUCTS, ProductCube } from "@/components/products";
import { nameOf } from "@/session/me";
import type { Me } from "@/session/platform-types";

interface Destination {
  readonly to: NonNullable<LinkProps["to"]>;
  readonly label: string;
  readonly Icon: LucideIcon;
}

/**
 * Where a person goes besides the products. A tile session on a shared device cannot change an
 * account, so it only goes back to the picker.
 */
const destinationsOf = (me: Me): ReadonlyArray<Destination> => {
  if (me.kind === "tile") return [{ to: "/", label: "Switch person", Icon: UsersIcon }];

  return [
    { to: "/settings", label: "Settings", Icon: SettingsIcon },
    ...(me.scopes.includes("admin")
      ? [{ to: "/admin", label: "Admin", Icon: ShieldCheckIcon } as const]
      : []),
  ];
};

export function HomeView({ me }: { readonly me: Me }) {
  return (
    <div className="px-4 md:px-16">
      <div className="mx-auto flex max-w-content flex-col">
        <h1 className="flex flex-col justify-end pt-16 pb-10 font-display text-product/11 font-heavy tracking-hero break-words text-text font-stretch-125% md:h-81 md:pt-0 md:pb-14 md:text-greeting/20">
          {`Hi, ${nameOf(me)}.`}
        </h1>
        <ul className="flex flex-col border-b border-hairline lg:flex-row">
          {PRODUCTS.map((product) => (
            <li
              key={product.href}
              className="flex-1 not-first:border-t not-first:border-hairline lg:not-first:ml-12 lg:not-first:border-t-0 lg:not-first:border-l lg:not-first:pl-12"
            >
              <a
                href={product.href}
                className="group flex items-center gap-6 rounded-control py-8 md:gap-11 md:py-14"
              >
                <ProductCube product={product} className="size-24 md:size-46" />
                <span className="flex flex-col gap-3.5">
                  <span className="text-heading/heading font-semibold tracking-snug text-text md:text-product/11">
                    {product.label}
                  </span>
                  <span
                    aria-hidden
                    className="flex items-center gap-2 pt-1.5 text-button/5 font-semibold text-accent"
                  >
                    Open
                    <ArrowRightIcon
                      className="size-4.5 transition-transform group-hover:translate-x-1"
                      strokeWidth={2}
                    />
                  </span>
                </span>
              </a>
            </li>
          ))}
        </ul>
        <nav aria-label="Account" className="flex flex-wrap items-center gap-x-14 gap-y-4 pt-10">
          {destinationsOf(me).map(({ to, label, Icon }) => (
            <Link
              key={to}
              to={to}
              className="flex items-center gap-3 rounded-control text-section/6 font-semibold text-text transition-colors hover:text-accent"
            >
              <Icon className="size-5 text-text-muted" strokeWidth={1.75} aria-hidden />
              {label}
            </Link>
          ))}
        </nav>
      </div>
    </div>
  );
}
