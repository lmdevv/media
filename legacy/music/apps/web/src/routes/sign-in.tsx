import { useAuthActions } from "@convex-dev/auth/react";
import { Redirect } from "@/components/redirect";
import { commandFailure } from "@music/sdk/errors";
import { setupStatus } from "@music/sdk/functions";
import { Button } from "@music/ui/components/button";
import { FieldHint, FieldLabel, Input } from "@music/ui/components/input";
import { createFileRoute } from "@tanstack/react-router";
import { useConvexAuth, useQuery } from "convex/react";
import { Match, Schema } from "effect";
import { useState } from "react";
import type { FormEvent } from "react";

import { AuthHeading, AuthLayout, Field } from "@/components/auth/auth-layout";
import { signInFailure } from "@/lib/sign-in-failure";
import type { SignInFailure } from "@/lib/sign-in-failure";

const SignInSearch = Schema.Struct({ redirect: Schema.optionalKey(Schema.String) });

export const Route = createFileRoute("/sign-in")({
  validateSearch: Schema.toStandardSchemaV1(SignInSearch),
  component: SignInPage,
});

const host = window.location.host;

/** Only same-app paths are followed after sign-in. */
const safeRedirect = (target: string | undefined): string =>
  target !== undefined && target.startsWith("/") && !target.startsWith("//") ? target : "/";

function SignInPage() {
  const status = useQuery(setupStatus, {});
  const { isLoading, isAuthenticated } = useConvexAuth();
  const { redirect } = Route.useSearch();

  if (status === undefined || isLoading) return <div className="min-h-dvh bg-bg" />;

  if (!status.hasUsers) return <Redirect href="/setup" />;

  if (isAuthenticated) return <Redirect href={safeRedirect(redirect)} />;

  return <SignInForm />;
}

/** What the sign-in form says after a failure, and whether it blames the credentials. */
interface Failed {
  readonly message: string;
  readonly credentials: boolean;
}

/** Messages for failures the server did not explain itself (see `signInFailure`). */
const describeSignInFailure = (failure: SignInFailure): string =>
  Match.value(failure).pipe(
    Match.when("credentials", () => "That email and password don't match."),
    Match.when("rate-limited", () => "Too many attempts. Wait a minute and try again."),
    Match.when("server", () => "Couldn't sign in. The server reported an error."),
    Match.exhaustive,
  );

/**
 * Reads a failed sign-in: the password provider's own refusals carry a code and a message meant
 * for people (wrong credentials, too many attempts, a suspended account); anything else is
 * classified by `signInFailure`.
 */
const failedFrom = (cause: Error | null): Failed => {
  const failure = cause === null ? null : commandFailure(cause);

  if (failure !== null) {
    return { message: failure.message, credentials: failure.code === "unauthenticated" };
  }

  const kind = cause === null ? "server" : signInFailure(cause);

  return { message: describeSignInFailure(kind), credentials: kind === "credentials" };
};

function SignInForm() {
  const { signIn } = useAuthActions();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  // The server explains refusals it means (a suspended account, too many attempts); anything
  // else is classified here, and wrong passwords stay generic.
  const [failed, setFailed] = useState<Failed | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPending(true);
    setFailed(null);

    try {
      await signIn("password", { email, password, flow: "signIn" });
    } catch (cause) {
      setFailed(cause instanceof Error ? failedFrom(cause) : failedFrom(null));
    } finally {
      setPending(false);
    }
  };

  return (
    <AuthLayout eyebrow="SIGN IN">
      <AuthHeading title="Welcome back" lead={`Sign in to ${host}`} />
      <form className="flex flex-col gap-7" onSubmit={(event) => void submit(event)}>
        <div className="flex flex-col gap-4">
          <Field>
            <FieldLabel htmlFor="sign-in-email">Email</FieldLabel>
            <Input
              id="sign-in-email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="sign-in-password">Password</FieldLabel>
            <Input
              id="sign-in-password"
              type="password"
              autoComplete="current-password"
              required
              aria-invalid={failed?.credentials === true}
              aria-describedby={failed === null ? undefined : "sign-in-error"}
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
                setFailed(null);
              }}
            />
            {failed === null ? null : (
              <FieldHint id="sign-in-error" tone="danger" role="alert">
                {failed.message}
              </FieldHint>
            )}
          </Field>
        </div>
        <Button type="submit" variant="solid" size="lg" pending={pending}>
          {pending ? "Signing in…" : "Sign in"}
        </Button>
      </form>
    </AuthLayout>
  );
}
