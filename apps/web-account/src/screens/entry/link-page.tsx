import { buttonVariants } from "@media/ui/lib/button-variants";
import { Link } from "@tanstack/react-router";
import { Match } from "effect";
import type { ReactNode } from "react";

import { AuthPage, Lede, PageTitle } from "@/components/auth-page";
import { isFailure } from "@/lib/failure";

import { AccountForm } from "./account-form";
import type { AccountFields } from "./account-form";
import type { Lookup } from "./lookup";
import type { Submission } from "./submission";

/** What an invite or reset link's lookup shows: the link, or why it can't. */
export type LinkState<Found> =
  | { readonly kind: "loading" }
  /** Used, revoked, expired, or never issued: the core tells these apart to no one. */
  | { readonly kind: "ended" }
  | { readonly kind: "unreachable"; readonly retry: () => void }
  | { readonly kind: "open"; readonly link: Found };

/** The state a link's lookup puts the page in. */
export const linkStateOf = <Found,>(lookup: Lookup<Found>): LinkState<Found> =>
  Match.value(lookup).pipe(
    Match.discriminatorsExhaustive("status")({
      loading: (): LinkState<Found> => ({ kind: "loading" }),
      success: ({ data }): LinkState<Found> => ({ kind: "open", link: data }),
      error: ({ error, retry }): LinkState<Found> =>
        isFailure(error, "Expired") || isFailure(error, "NotFound")
          ? { kind: "ended" }
          : { kind: "unreachable", retry },
    }),
  );

/** The day a link stops working, such as `Nov 12`. */
const formatDay = (epochMs: number): string =>
  new Date(epochMs).toLocaleDateString(undefined, { month: "short", day: "numeric" });

/** A one-time link that no longer works: its title, what to do, and a way to sign in. */
export function EndedLink({ title, next }: { readonly title: string; readonly next: string }) {
  return (
    <AuthPage>
      <div className="flex flex-col gap-3">
        <PageTitle>{title}</PageTitle>
        <Lede>{next}</Lede>
      </div>
      <Link
        to="/"
        className={buttonVariants({ variant: "subtle", size: "lg", className: "w-full" })}
      >
        I already have an account
      </Link>
    </AuthPage>
  );
}

/** A link page opened without its link, as after a reload, which drops the link's secret. */
export function MissingLink() {
  return (
    <EndedLink
      title="Open your link again."
      next="This page lets go of the link once it opens, so a reload loses it."
    />
  );
}

/** What the person types into an open link's form, and how its submit goes. */
export interface LinkForm {
  readonly username: string;
  readonly password: string;
  readonly submission: Submission;
  readonly onUsernameChange: (username: string) => void;
  readonly onPasswordChange: (password: string) => void;
  readonly onSubmit: () => void;
}

/**
 * An open invite or reset link: who it is from or for, with the day it stops working in mono, the
 * title, and its form.
 */
export function OpenLink({
  heading,
  facts,
  expiresAt,
  title,
  fields,
  submitLabel,
  form,
}: {
  readonly heading: ReactNode;
  readonly facts: string;
  readonly expiresAt: number;
  readonly title: string;
  readonly fields: AccountFields;
  readonly submitLabel: string;
  readonly form: LinkForm;
}) {
  return (
    <AuthPage>
      <div className="flex flex-col gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="text-body/5 font-semibold text-text">{heading}</p>
          <p className="truncate font-mono text-caption/caption text-text-muted">
            {facts} · expires {formatDay(expiresAt)}
          </p>
        </div>
        <PageTitle>{title}</PageTitle>
      </div>
      <AccountForm fields={fields} submitLabel={submitLabel} {...form} />
    </AuthPage>
  );
}
