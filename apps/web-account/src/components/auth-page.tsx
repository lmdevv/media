import { TextField } from "@media/ui/components/text-field";
import { Wordmark } from "@media/ui/components/wordmark";
import { cn } from "@media/ui/lib/utils";
import { CheckIcon, EyeIcon, EyeOffIcon } from "lucide-react";
import { useState } from "react";
import type { ComponentProps, ReactNode } from "react";

const TAGLINE = "Your own streaming service.";

const WIDTHS = {
  form: "w-100",
  wide: "w-120",
  page: "w-full max-w-content",
} as const;

/**
 * A page outside the signed-in shell: sign-in, the picker, a lock screen, an invite, a reset link.
 * The Lar wordmark sits top left, as on movies' sign-in page.
 *
 * @param width - `form` (400px), `wide` (480px), or `page` (the content width).
 * @param centered - Centers the column on the page, for the pickers.
 * @param tagline - Puts the tagline under the wordmark, for the sign-in page.
 */
export function AuthPage({
  children,
  width = "form",
  centered = false,
  tagline = false,
}: {
  readonly children: ReactNode;
  readonly width?: keyof typeof WIDTHS;
  readonly centered?: boolean;
  readonly tagline?: boolean;
}) {
  return (
    <div className="flex min-h-svh flex-col bg-page font-sans text-text">
      <header className="flex h-16 shrink-0 flex-col justify-center px-5 md:h-24 md:px-16">
        <a href="/" aria-label="Lar home" className="self-start rounded-bar">
          <Wordmark product="media" />
        </a>
        {tagline ? <p className="text-caption/caption text-text-muted">{TAGLINE}</p> : null}
      </header>
      <main
        className={cn(
          "flex grow flex-col items-center px-5 pb-16",
          centered ? "pt-6 md:justify-center md:pt-0 md:pb-24" : "pt-10 md:pt-22",
        )}
      >
        <div className={cn("flex max-w-full flex-col gap-8", WIDTHS[width])}>{children}</div>
      </main>
    </div>
  );
}

/** A page heading: bold, tight, 32px. */
export function PageTitle({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <h1 className={cn("text-title/title font-bold tracking-display text-text", className)}>
      {children}
    </h1>
  );
}

/** Muted body text under a page title. */
export function Lede({ children }: { readonly children: ReactNode }) {
  return <p className="text-body/body text-text-muted">{children}</p>;
}

/**
 * A password field with the eye button that shows the password. `hint` adds the check line Paper
 * draws under a new password once it is long enough.
 */
export function PasswordField({
  hint,
  ...props
}: Omit<ComponentProps<typeof TextField>, "type" | "trailing"> & {
  readonly hint?: string | undefined;
}) {
  const [visible, setVisible] = useState(false);

  return (
    <div className="flex flex-col gap-1.5">
      <TextField
        {...props}
        type={visible ? "text" : "password"}
        trailing={
          <button
            type="button"
            onClick={() => setVisible((shown) => !shown)}
            aria-label={visible ? "Hide password" : "Show password"}
            className="flex cursor-pointer items-center rounded-bar text-text-muted hover:text-text"
          >
            {visible ? (
              <EyeOffIcon className="size-4.5" strokeWidth={1.75} aria-hidden />
            ) : (
              <EyeIcon className="size-4.5" strokeWidth={1.75} aria-hidden />
            )}
          </button>
        }
      />
      {hint === undefined ? null : (
        <p className="flex items-center gap-1.5 text-caption/caption text-text-muted">
          <CheckIcon className="size-3.5 text-success" strokeWidth={2} aria-hidden />
          {hint}
        </p>
      )}
    </div>
  );
}
