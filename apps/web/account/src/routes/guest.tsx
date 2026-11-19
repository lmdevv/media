import { usePlatform, usePlatformQuery, usePlatformStatus } from "@media/sdk/react";
import { Button } from "@media/ui/components/button";
import { GuestUnavailable } from "@media/ui/components/guest-unavailable";
import { TextField } from "@media/ui/components/text-field";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { AuthPage, Lede, PageTitle } from "@/components/auth-page";
import { BlankPage, UnreachableScreen } from "@/screens/states";
import { guestFailure, guestGate } from "@/screens/guest/state";
import type { GuestSubmission } from "@/screens/guest/state";
import { useAccountActions } from "@/session/account";
import { linkSecretFor } from "@/session/link-secret";
import { nameOf } from "@/session/me";
import { isRenewing, linkRefused, useIdentityRetry } from "@media/ui/lib/session-identity";

export const Route = createFileRoute("/guest")({
  staticData: { need: "public" },
  head: () => ({ meta: [{ title: "Watch as a guest · Lar" }] }),
  component: GuestPage,
});

function GuestDestination() {
  const { signOut } = useAccountActions();
  const platform = usePlatform();
  const guest = usePlatformQuery(platform.core.guests.current);
  useIdentityRetry(guest);
  const target = guest.status === "success" ? guest.data?.target : undefined;
  const destination = target?.kind === "item" ? `/${target.item.domain}/guest` : null;

  useEffect(() => {
    if (destination !== null) window.location.replace(destination);
  }, [destination]);

  if (
    guest.status === "loading" ||
    (guest.status === "error" && isRenewing(guest.error)) ||
    destination !== null
  )
    return <BlankPage />;

  if (guest.status === "error" && !linkRefused(guest.error))
    return <UnreachableScreen retry={guest.retry} />;

  return <GuestUnavailable onLeave={signOut} />;
}

function GuestPage() {
  const code = linkSecretFor(Route.useRouteContext().linkSecret, "/guest");
  const platform = usePlatform();
  const status = usePlatformStatus();

  const me = usePlatformQuery(
    platform.core.auth.sessions.current,
    ...(status === "signedIn" ? [] : (["skip"] as const)),
  );

  useIdentityRetry(me);

  const { signInAsGuest, signOut } = useAccountActions();
  const [confirmed, setConfirmed] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [submission, setSubmission] = useState<GuestSubmission>({ kind: "idle" });
  const busy = useRef(false);
  const [opened, setOpened] = useState(false);

  const identityFailed = me.status === "error" && !isRenewing(me.error);

  const gate = guestGate({
    status,
    role:
      me.status !== "success"
        ? identityFailed
          ? "failed"
          : "loading"
        : me.data.role === "guest"
          ? "guest"
          : "household",
    hasCode: code !== "",
    opened,
    confirmed: me.status === "success" && confirmed === `${me.data.userId}|${me.data.sessionId}`,
    submitting: submission.kind === "submitting",
  });

  if (gate === "unreachable" && me.status === "error")
    return <UnreachableScreen retry={me.retry} />;

  if (gate === "loading") return <BlankPage />;

  if (gate === "resume") return <GuestDestination />;

  const leave = async (): Promise<void> => {
    if (me.status === "success" && me.data.role === "guest") await signOut();
    else window.location.replace("/home");
  };

  if (gate === "unavailable" || submission.kind === "unavailable")
    return <GuestUnavailable onLeave={leave} />;

  if (submission.kind === "changed")
    return (
      <AuthPage>
        <PageTitle>Someone else signed in here</PageTitle>
        <Lede>Their sign-in was kept. Continue to review it before opening this link again.</Lede>
        <Button
          onClick={() => {
            setConfirmed(null);
            setSubmission({ kind: "idle" });
          }}
        >
          Continue
        </Button>
        <Button variant="secondary" onClick={() => window.location.replace("/home")}>
          Leave
        </Button>
      </AuthPage>
    );

  if (gate === "confirm" && me.status === "success") {
    return (
      <AuthPage>
        <PageTitle>Replace this sign-in?</PageTitle>
        <Lede>{nameOf(me.data)} is signed in on this browser.</Lede>
        <Button onClick={() => setConfirmed(`${me.data.userId}|${me.data.sessionId}`)}>
          Continue as a guest
        </Button>
        <Button variant="secondary" onClick={() => window.location.replace("/home")}>
          Cancel
        </Button>
      </AuthPage>
    );
  }

  if (submission.kind === "full")
    return (
      <AuthPage>
        <PageTitle>This link is full</PageTitle>
      </AuthPage>
    );

  const submit = async (): Promise<void> => {
    if (busy.current) return;
    busy.current = true;
    setSubmission({ kind: "submitting" });

    try {
      const outcome = await signInAsGuest({ code, name: name.trim(), replacing: confirmed });

      if (outcome === "changed") {
        setSubmission({ kind: "changed" });
        busy.current = false;
      } else setOpened(true);
    } catch (cause) {
      setSubmission(guestFailure(cause));
      busy.current = false;
    }
  };

  return (
    <AuthPage>
      <PageTitle>Watch as a guest</PageTitle>
      <form
        className="flex flex-col gap-5"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <TextField
          label="Display name"
          autoComplete="nickname"
          value={name}
          disabled={submission.kind === "submitting"}
          onChange={(event) => {
            setName(event.target.value);

            if (submission.kind === "failed") setSubmission({ kind: "idle" });
          }}
          required
        />
        {submission.kind === "failed" ? (
          <p role="alert" className="text-body/body text-destructive">
            {submission.message}
          </p>
        ) : null}
        <Button type="submit" disabled={submission.kind === "submitting" || name.trim() === ""}>
          {submission.kind === "submitting" ? "Opening…" : "Watch"}
        </Button>
      </form>
    </AuthPage>
  );
}
