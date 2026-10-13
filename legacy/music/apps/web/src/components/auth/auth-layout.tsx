import type { ReactNode } from "react";

import { placeholderAt } from "@/lib/art";

import { version } from "../../../package.json";

const host = window.location.host.toUpperCase();

/**
 * The setup and sign-in frame from Paper page 02: a 600px column with the wordmark, a step label,
 * the form, and the server address, beside a wall of album-art placeholders. Phones show only the
 * column.
 */
export function AuthLayout({
  eyebrow,
  children,
}: {
  readonly eyebrow: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex min-h-dvh bg-bg">
      <div className="flex w-full shrink-0 flex-col justify-between gap-12 px-6 py-8 lg:w-[600px] lg:px-[72px] lg:py-12">
        <div className="flex items-center justify-between">
          <span className="font-mono text-md/base font-semibold text-text">[music]</span>
          <span className="font-mono text-xs/xs tracking-mono text-text-muted">{eyebrow}</span>
        </div>
        <main className="flex flex-col gap-7">{children}</main>
        <span className="font-mono text-xs/xs tracking-mono text-text-muted">
          {host} · V{version}
        </span>
      </div>
      <div
        aria-hidden
        className="hidden grow grid-cols-3 grid-rows-3 gap-3 overflow-clip bg-surface p-3 lg:grid"
      >
        {Array.from({ length: 9 }, (_, index) => (
          <div
            key={index}
            className="rounded-md"
            style={{ backgroundImage: placeholderAt(index) }}
          />
        ))}
      </div>
    </div>
  );
}

/** The heavy display title and muted lead at the top of an auth step. */
export function AuthHeading({ title, lead }: { readonly title: string; readonly lead: ReactNode }) {
  return (
    <div className="flex flex-col gap-2.5">
      <h1 className="font-sans text-xl/xl font-heavy tracking-display text-text lg:text-2xl/2xl">
        {title}
      </h1>
      <p className="font-sans text-md/md text-text-muted">{lead}</p>
    </div>
  );
}

/** A label, field, and hint stacked with the Paper 6px rhythm. */
export function Field({ children }: { readonly children: ReactNode }) {
  return <div className="flex flex-col gap-1.5">{children}</div>;
}
