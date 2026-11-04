import { useAuth, useCommandQuery } from "@media/sdk/react";
import { Button } from "@media/ui/components/button";
import { FieldError, TextField } from "@media/ui/components/text-field";
import { Spinner } from "@media/ui/components/spinner";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArrowRightIcon, SmartphoneIcon } from "lucide-react";
import { Schema } from "effect";
import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";

import { AuthPage, PageTitle, PasswordField } from "@/components/auth/auth-page";
import { describeFailure } from "@/lib/failure";
import { safeRedirect } from "@/lib/redirect-target";
import { BlankPage, Redirect } from "@/session/redirect";

const SignInSearch = Schema.Struct({ redirect: Schema.optionalKey(Schema.String) });

export const Route = createFileRoute("/sign-in")({
  validateSearch: Schema.toStandardSchemaV1(SignInSearch),
  head: () => ({ meta: [{ title: "Sign in · [movies]" }] }),
  component: SignInPage,
});

function SignInPage() {
  const { status } = useAuth();
  const { redirect } = Route.useSearch();
  const setup = useCommandQuery("setup.status", {});
  const [deviceCode, setDeviceCode] = useState(false);
  const target = safeRedirect(redirect);

  if (status === "loading" || setup.status === "loading") return <BlankPage />;

  if (setup.status === "success" && !setup.data.hasOwner) return <Redirect href="/welcome" />;

  if (status === "signedIn") return <Redirect href={target} />;

  return deviceCode ? (
    <DeviceCodeSignIn onCancel={() => setDeviceCode(false)} />
  ) : (
    <PasswordSignIn target={target} onDeviceCode={() => setDeviceCode(true)} />
  );
}

function PasswordSignIn({
  target,
  onDeviceCode,
}: {
  readonly target: string;
  readonly onDeviceCode: () => void;
}) {
  const { signInWithPassword } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setPending(true);
    setError(null);

    try {
      await signInWithPassword({ flow: "signIn", email: email.trim(), password });
      await navigate({ href: target, replace: true });
    } catch (cause) {
      setError(describeFailure(cause));
      setPending(false);
    }
  };

  return (
    <AuthPage offset="lead">
      <PageTitle>Welcome back.</PageTitle>
      <form className="flex flex-col gap-8" onSubmit={(event) => void submit(event)}>
        <div className="flex flex-col gap-4">
          <TextField
            label="Email"
            name="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
          <PasswordField
            label="Password"
            name="password"
            autoComplete="current-password"
            required
            value={password}
            error={error ?? undefined}
            onChange={(event) => {
              setPassword(event.target.value);
              setError(null);
            }}
          />
        </div>
        <div className="flex flex-col gap-4">
          <Button type="submit" size="lg" className="w-full" disabled={pending}>
            Sign in
            <ArrowRightIcon strokeWidth={2} aria-hidden />
          </Button>
          <Button
            type="button"
            variant="subtle"
            size="lg"
            className="w-full"
            onClick={onDeviceCode}
          >
            <SmartphoneIcon strokeWidth={1.75} aria-hidden />
            Use a code from another device
          </Button>
        </div>
      </form>
    </AuthPage>
  );
}

function DeviceCodeSignIn({ onCancel }: { readonly onCancel: () => void }) {
  const { startDeviceLogin } = useAuth();

  const [code, setCode] = useState<{ readonly userCode: string; readonly url: string } | null>(
    null,
  );

  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;

    started.current = true;

    void (async () => {
      try {
        const login = await startDeviceLogin("[movies] web");

        setCode({ userCode: login.userCode, url: login.verificationUrl });
        await login.complete();
      } catch (cause) {
        setError(describeFailure(cause));
      }
    })();
  }, [startDeviceLogin]);

  return (
    <AuthPage offset="lead">
      <PageTitle>Use a code from another device.</PageTitle>
      <div className="flex flex-col gap-4">
        {code === null ? (
          error === null ? (
            <Spinner className="size-6 text-text" label="Getting a code" />
          ) : null
        ) : (
          <>
            <p className="text-body/body text-text-muted">
              On a device that is signed in, open {code.url} and enter
            </p>
            <p className="font-mono text-title/title font-medium tracking-caps text-text">
              {code.userCode}
            </p>
          </>
        )}
        {error === null ? null : <FieldError>{error}</FieldError>}
      </div>
      <Button variant="subtle" size="lg" className="w-full" onClick={onCancel}>
        Sign in with a password
      </Button>
    </AuthPage>
  );
}
