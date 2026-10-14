import { useAuthActions } from "@convex-dev/auth/react";
import { Redirect } from "@/components/redirect";
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

function SignInForm() {
  const { signIn } = useAuthActions();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState<SignInFailure | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPending(true);
    setFailed(null);

    try {
      await signIn("password", { email, password, flow: "signIn" });
    } catch (cause) {
      setFailed(cause instanceof Error ? signInFailure(cause) : "server");
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
              aria-invalid={failed === "credentials"}
              aria-describedby={failed === null ? undefined : "sign-in-error"}
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
                setFailed(null);
              }}
            />
            {failed === null ? null : (
              <FieldHint id="sign-in-error" tone="danger" role="alert">
                {Match.value(failed).pipe(
                  Match.when("credentials", () => "That email and password don't match."),
                  Match.when(
                    "rate-limited",
                    () => "Too many attempts. Wait a minute and try again.",
                  ),
                  Match.when("server", () => "Couldn't sign in. The server reported an error."),
                  Match.exhaustive,
                )}
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
