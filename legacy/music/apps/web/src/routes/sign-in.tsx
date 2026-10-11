import { useAuthActions } from "@convex-dev/auth/react";
import { Redirect } from "@/components/redirect";
import { setupStatus } from "@music/sdk/functions";
import { Button } from "@music/ui/components/button";
import { FieldHint, FieldLabel, Input } from "@music/ui/components/input";
import { createFileRoute } from "@tanstack/react-router";
import { useConvexAuth, useQuery } from "convex/react";
import { Schema } from "effect";
import { useState } from "react";
import type { FormEvent } from "react";

import { AuthHeading, AuthLayout, Field } from "@/components/auth/auth-layout";

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
  const [failed, setFailed] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPending(true);
    setFailed(false);

    try {
      await signIn("password", { email, password, flow: "signIn" });
    } catch {
      setFailed(true);
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
              aria-invalid={failed}
              aria-describedby={failed ? "sign-in-error" : undefined}
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
                setFailed(false);
              }}
            />
            {failed ? (
              <FieldHint id="sign-in-error" tone="danger" role="alert">
                That email and password don't match.
              </FieldHint>
            ) : null}
          </Field>
        </div>
        <Button type="submit" variant="solid" size="lg" pending={pending}>
          {pending ? "Signing in…" : "Sign in"}
        </Button>
      </form>
    </AuthLayout>
  );
}
