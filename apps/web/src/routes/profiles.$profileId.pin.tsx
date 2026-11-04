import { ProfileId } from "@media/contracts/ids";
import type { Profile } from "@media/contracts/models/profiles";
import { useCommand, useCommandQuery } from "@media/sdk/react";
import { Avatar } from "@media/ui/components/avatar";
import { CodeInput } from "@media/ui/components/code-input";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { CircleAlertIcon } from "lucide-react";
import { Match, Schema } from "effect";
import { useEffect, useRef, useState } from "react";

import { AuthPage } from "@/components/auth/auth-page";
import { profileArt } from "@/components/profiles/profile-art";
import { describeFailure } from "@/lib/failure";
import { PIN_LENGTH } from "@/lib/pin";
import { safeRedirect } from "@/lib/redirect-target";
import { PageFailure, RequireSignedIn } from "@/session/guards";
import { useProfileChoice } from "@/session/profile-choice";
import { BlankPage, Redirect } from "@/session/redirect";

const PinSearch = Schema.Struct({ redirect: Schema.optionalKey(Schema.String) });

const decodeProfileId = Schema.decodeSync(ProfileId);

export const Route = createFileRoute("/profiles/$profileId/pin")({
  params: {
    parse: (raw) => ({ profileId: decodeProfileId(raw.profileId) }),
    stringify: (params) => ({ profileId: params.profileId }),
  },
  validateSearch: Schema.toStandardSchemaV1(PinSearch),
  head: () => ({ meta: [{ title: "Enter PIN · [movies]" }] }),
  component: () => (
    <RequireSignedIn>
      <PinPage />
    </RequireSignedIn>
  ),
});

const clock = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" });

function PinPage() {
  const { profileId } = Route.useParams();
  const profiles = useCommandQuery("profiles.list", {});

  if (profiles.status === "loading") return <BlankPage />;

  if (profiles.status === "error")
    return <PageFailure cause={profiles.error} retry={profiles.retry} />;

  const profile = profiles.data.find((candidate) => candidate.id === profileId);

  if (profile === undefined) return <Redirect href="/profiles" />;

  return <PinEntry profile={profile} />;
}

function PinEntry({ profile }: { readonly profile: Profile }) {
  const { redirect } = Route.useSearch();
  const unlock = useCommand("profiles.unlock");
  const { choose } = useProfileChoice();
  const navigate = useNavigate();
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const checking = useRef(false);
  const target = safeRedirect(redirect);
  const art = profileArt(profile);

  const open = (): void => {
    choose(profile.id);
    void navigate({ href: target, replace: true });
  };

  const submit = async (value: string): Promise<void> => {
    checking.current = true;

    try {
      const result = await unlock({ profileId: profile.id, pin: value });

      Match.value(result).pipe(
        Match.when({ status: "unlocked" }, open),
        Match.when({ status: "wrong_pin" }, ({ attemptsLeft }) => {
          setError(`Wrong PIN. ${attemptsLeft} ${attemptsLeft === 1 ? "try" : "tries"} left.`);
          setPin("");
        }),
        Match.when({ status: "locked_out" }, ({ retryAt }) => {
          setError(`Too many wrong PINs. Try again at ${clock.format(retryAt)}.`);
          setPin("");
        }),
        Match.exhaustive,
      );
    } catch (cause) {
      setError(describeFailure(cause));
      setPin("");
    } finally {
      checking.current = false;
    }
  };

  if (!profile.locked) return <OpenProfile onOpen={open} />;

  return (
    <AuthPage width="dialog" offset="centered">
      <div className="flex flex-col items-center gap-10">
        <div className="flex flex-col items-center gap-5">
          <Avatar name={profile.name} image={art.image} monogram={art.monogram} size="md" />
          <h1 className="text-center text-title/title font-bold tracking-display text-text">
            Enter {profile.name}'s PIN
          </h1>
        </div>
        <CodeInput
          kind="pin"
          length={PIN_LENGTH}
          label={`${profile.name}'s PIN`}
          value={pin}
          invalid={error !== null}
          onValueChange={(next) => {
            setPin(next);

            if (next !== "") setError(null);
          }}
          onComplete={(value) => {
            if (!checking.current) void submit(value);
          }}
        />
        <p role="alert" className="flex min-h-5.5 items-center gap-2 text-body/body text-danger">
          {error === null ? null : (
            <>
              <CircleAlertIcon className="size-4 shrink-0" strokeWidth={1.75} aria-hidden />
              {error}
            </>
          )}
        </p>
      </div>
    </AuthPage>
  );
}

function OpenProfile({ onOpen }: { readonly onOpen: () => void }) {
  const opened = useRef(false);

  useEffect(() => {
    if (opened.current) return;

    opened.current = true;
    onOpen();
  }, [onOpen]);

  return <BlankPage />;
}
