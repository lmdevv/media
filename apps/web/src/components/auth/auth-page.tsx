import { TextField } from "@media/ui/components/text-field";
import { Wordmark } from "@media/ui/components/wordmark";
import { cn } from "@media/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import { CheckIcon, EyeIcon, EyeOffIcon } from "lucide-react";
import { useState } from "react";
import type { ComponentProps, ReactNode } from "react";

const WIDTHS = {
  form: "w-100",
  wide: "w-120",
  dialog: "w-dialog",
  page: "w-full max-w-content",
} as const;

/**
 * A setup or sign-in page.
 *
 * @param width - `form` (400px), `wide` (480px), `dialog` (560px), or `page` (the content width).
 * @param offset - Space above the column: `step` for setup steps, `lead` for sign-in and expired
 *   invites, `tight` for an invite with its header, `centered` for profiles.
 * @param phoneBrand - Show the wordmark on phones too; the iOS profile screens leave it out.
 */
export function AuthPage({
  children,
  width = "form",
  offset = "step",
  phoneBrand = true,
}: {
  readonly children: ReactNode;
  readonly width?: keyof typeof WIDTHS;
  readonly offset?: "step" | "lead" | "tight" | "centered";
  readonly phoneBrand?: boolean;
}) {
  return (
    <div className="flex min-h-svh flex-col bg-page font-sans text-text">
      <header
        className={cn(
          "h-16 shrink-0 items-center px-5 md:flex md:h-24 md:px-16",
          phoneBrand ? "flex" : "hidden",
        )}
      >
        <Link to="/" aria-label="[movies] home" className="rounded-bar">
          <Wordmark />
        </Link>
      </header>
      <main
        className={cn(
          "flex grow flex-col items-center px-5 pb-16",
          offset === "step" && "pt-6 md:pt-14",
          offset === "lead" && "pt-10 md:pt-22",
          offset === "tight" && "pt-6",
          offset === "centered" &&
            "pt-[max(env(safe-area-inset-top),var(--spacing-12))] md:justify-center md:pt-0 md:pb-24",
        )}
      >
        <div className={cn("flex max-w-full flex-col gap-8", WIDTHS[width])}>{children}</div>
      </main>
    </div>
  );
}

/** The `STEP 2 OF 3 · LIBRARY` line with its three bars. */
export function SetupSteps({ step, label }: { readonly step: 1 | 2 | 3; readonly label: string }) {
  return (
    <div className="flex items-center gap-3 pb-2">
      <div aria-hidden className="flex gap-1">
        {[1, 2, 3].map((bar) => (
          <span
            key={bar}
            className={cn("h-0.75 w-6 rounded-pill", bar <= step ? "bg-accent" : "bg-hairline")}
          />
        ))}
      </div>
      <p className="font-mono text-caption/caption tracking-caps text-text-muted uppercase">
        Step {step} of 3 · {label}
      </p>
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

/**
 * A password field with the eye button that shows the password. `hint` adds the green check line
 * Paper draws under a new password once it is long enough.
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
