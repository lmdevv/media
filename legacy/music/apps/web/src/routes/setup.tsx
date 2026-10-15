import { useAuthActions } from "@convex-dev/auth/react";
import { Redirect } from "@/components/redirect";
import { JobId } from "@music/commands/ids";
import type { Job } from "@music/commands/models";
import { setupStatus } from "@music/sdk/functions";
import { useRead, useRun } from "@music/sdk/react";
import { Button } from "@music/ui/components/button";
import { Chip } from "@music/ui/components/chip";
import { FieldHint, FieldLabel, Input } from "@music/ui/components/input";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useConvexAuth, useQuery } from "convex/react";
import { Schema } from "effect";
import { CheckIcon, FolderIcon } from "lucide-react";
import { useEffect, useState } from "react";
import type { FormEvent } from "react";

import { AuthHeading, AuthLayout, Field } from "@/components/auth/auth-layout";
import { ProgressBar } from "@/components/auth/scan-progress";
import { jobEta, jobPercent } from "@/lib/job-progress";
import { describeFailure, toastFailure } from "@/lib/action";
import { formatCount, formatTime, plural } from "@/lib/format";
import { useNow } from "@/lib/use-now";

const SetupSearch = Schema.Struct({
  step: Schema.optionalKey(Schema.Literals(["library", "scan"])),
  jobId: Schema.optionalKey(JobId),
});

export const Route = createFileRoute("/setup")({
  validateSearch: Schema.toStandardSchemaV1(SetupSearch),
  component: SetupPage,
});

const MIN_PASSWORD = 8;

function SetupPage() {
  const status = useQuery(setupStatus, {});
  const { isLoading, isAuthenticated } = useConvexAuth();
  const search = Route.useSearch();
  // Sign-up creates the user before the session is ready; keep the form until it is.
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (isAuthenticated) setCreating(false);
  }, [isAuthenticated]);

  if (status === undefined || isLoading) return <div className="min-h-dvh bg-bg" />;

  if (!status.hasUsers || creating) return <CreateAdminStep onCreating={setCreating} />;

  if (!isAuthenticated) return <Redirect href="/sign-in" />;

  if (search.step === "scan" && search.jobId !== undefined) {
    return <ScanStep jobId={search.jobId} />;
  }

  if (search.step === undefined && status.hasLibraries) return <Redirect href="/" />;

  return <LibraryStep />;
}

function CreateAdminStep({ onCreating }: { readonly onCreating: (creating: boolean) => void }) {
  const { signIn } = useAuthActions();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tooShort = password.length > 0 && password.length < MIN_PASSWORD;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (password.length < MIN_PASSWORD) {
      setError(`Use at least ${MIN_PASSWORD} characters.`);

      return;
    }

    setPending(true);
    setError(null);
    onCreating(true);

    try {
      await signIn("password", { email, password, name, flow: "signUp" });
    } catch (cause) {
      onCreating(false);
      setError(describeFailure(cause));
    } finally {
      setPending(false);
    }
  };

  return (
    <AuthLayout eyebrow="STEP 1 OF 3">
      <AuthHeading
        title="Your music, your server."
        lead="Create the admin account. You'll invite everyone else after."
      />
      <form className="flex flex-col gap-7" onSubmit={(event) => void submit(event)}>
        <div className="flex flex-col gap-4">
          <Field>
            <FieldLabel htmlFor="setup-name">Name</FieldLabel>
            <Input
              id="setup-name"
              autoComplete="name"
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="setup-email">Email</FieldLabel>
            <Input
              id="setup-email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="setup-password">Password</FieldLabel>
            <Input
              id="setup-password"
              type="password"
              autoComplete="new-password"
              required
              aria-invalid={error !== null || tooShort}
              aria-describedby="setup-password-hint"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            <FieldHint id="setup-password-hint" tone={error === null ? "muted" : "danger"}>
              {error ?? `At least ${MIN_PASSWORD} characters.`}
            </FieldHint>
          </Field>
        </div>
        <Button type="submit" variant="solid" size="lg" pending={pending}>
          {pending ? "Creating account…" : "Create admin account"}
        </Button>
      </form>
    </AuthLayout>
  );
}

const libraryName = (path: string): string =>
  path.split("/").findLast((part) => part.length > 0) ?? "Music";

function LibraryStep({
  initialPath = "/music",
  failure = null,
}: {
  readonly initialPath?: string;
  readonly failure?: string | null;
}) {
  const navigate = useNavigate();
  const createLibrary = useRun("libraries.create");
  const [path, setPath] = useState(initialPath);
  const [visibility, setVisibility] = useState<"shared" | "private">("shared");
  const [error, setError] = useState<string | null>(failure);
  const [pending, setPending] = useState<"scan" | "another" | null>(null);
  const [added, setAdded] = useState<ReadonlyArray<string>>([]);
  const trimmed = path.trim();
  const absolute = trimmed.startsWith("/");

  const create = async (mode: "scan" | "another") => {
    if (!absolute) {
      setError("Use an absolute path that the server can read, such as /music.");

      return;
    }

    setPending(mode);
    setError(null);

    try {
      const result = await createLibrary({ name: libraryName(trimmed), path: trimmed, visibility });

      if (mode === "scan") {
        await navigate({ to: "/setup", search: { step: "scan", jobId: result.jobId } });
      } else {
        setAdded((list) => [...list, trimmed]);
        setPath("");
      }
    } catch (cause) {
      setError(describeFailure(cause));
    } finally {
      setPending(null);
    }
  };

  return (
    <AuthLayout eyebrow="STEP 2 OF 3">
      <AuthHeading
        title="Where's your music?"
        lead="A folder the server can read, like a NAS mount. [music] never moves or edits your files unless you ask."
      />
      <form
        className="flex flex-col gap-7"
        onSubmit={(event) => {
          event.preventDefault();
          void create("scan");
        }}
      >
        <Field>
          <FieldLabel htmlFor="setup-folder">Library folder</FieldLabel>
          <Input
            id="setup-folder"
            className="font-mono text-base/sm"
            spellCheck={false}
            autoComplete="off"
            aria-invalid={error !== null}
            aria-describedby="setup-folder-hint"
            value={path}
            onChange={(event) => {
              setPath(event.target.value);
              setError(null);
            }}
            start={<FolderIcon aria-hidden />}
            end={
              absolute && error === null ? (
                <CheckIcon aria-label="Looks like a valid path" className="text-success!" />
              ) : null
            }
          />
          <FieldHint
            id="setup-folder-hint"
            tone={error === null ? "muted" : "danger"}
            className="text-sm/sm"
          >
            {error ??
              (added.length > 0
                ? `Added ${added.join(", ")}. Add another or start scanning.`
                : "The path inside the server or container, such as /music.")}
          </FieldHint>
        </Field>
        {error === null ? (
          <Field>
            <span className="font-sans text-sm/xs font-medium text-text">Who can see it</span>
            <div className="flex gap-2" role="group" aria-label="Who can see it">
              <Chip selected={visibility === "shared"} onClick={() => setVisibility("shared")}>
                Everyone on this server
              </Chip>
              <Chip selected={visibility === "private"} onClick={() => setVisibility("private")}>
                Only me
              </Chip>
            </div>
          </Field>
        ) : null}
        <div className="flex gap-2.5">
          <Button
            type="submit"
            variant="solid"
            size="lg"
            className="grow"
            disabled={trimmed.length === 0 || error !== null}
            pending={pending === "scan"}
          >
            Start scanning
          </Button>
          {error === null ? (
            <Button
              type="button"
              variant="ghost"
              size="lg"
              disabled={trimmed.length === 0}
              pending={pending === "another"}
              onClick={() => void create("another")}
            >
              Add another folder
            </Button>
          ) : null}
        </div>
      </form>
    </AuthLayout>
  );
}

function ScanStep({ jobId }: { readonly jobId: JobId }) {
  const job = useRead("jobs.get", { jobId });
  const libraries = useRead("libraries.list", {});
  const library = libraries?.find((entry) => entry.id === job?.libraryId);

  if (job === undefined || libraries === undefined) {
    return (
      <AuthLayout eyebrow="STEP 3 OF 3">
        <AuthHeading title="Reading your library" lead="Connecting to the scanner…" />
      </AuthLayout>
    );
  }

  const failed = job.status === "failed" || job.status === "cancelled";

  if (failed && job.done === 0) {
    return (
      <LibraryStep
        initialPath={library?.path ?? "/music"}
        failure={`The server can't read this folder${job.error === null ? "." : `: ${job.error}`}. If it's on a NAS, mount it into the container, for example -v /mnt/nas/Music:/music, then use /music.`}
      />
    );
  }

  if (failed) return <ScanFailed job={job} path={library?.path ?? "the folder"} />;

  return <ScanRunning job={job} path={library?.path ?? ""} />;
}

function ScanRunning({ job, path }: { readonly job: Job; readonly path: string }) {
  const navigate = useNavigate();
  const home = useRead("library.home", {});
  const now = useNow(1000, job.status === "running");
  const percent = jobPercent(job);
  const eta = job.status === "pending" ? "WAITING FOR THE SCANNER" : jobEta(job, now);
  const stats = home?.stats;

  return (
    <AuthLayout eyebrow="STEP 3 OF 3">
      <AuthHeading
        title={job.status === "done" ? "Your library is ready" : "Reading your library"}
        lead={
          job.status === "done"
            ? `Found ${plural(stats?.tracks ?? job.done, "song")} in ${path}.`
            : "You can start listening now. Albums appear as they're found."
        }
      />
      <div className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between gap-4">
          <span className="font-sans text-2xl/2xl font-heavy tracking-display text-text lg:text-display/display">
            {percent === null ? "—" : `${percent}%`}
          </span>
          {eta === null ? null : (
            <span className="font-mono text-xs/xs tracking-mono text-text-muted">{eta}</span>
          )}
        </div>
        <ProgressBar percent={percent ?? 0} label={`Scanning ${path}`} />
        <div className="flex gap-6">
          <Stat value={stats?.tracks ?? 0} label="songs" />
          <Stat value={stats?.albums ?? 0} label="albums" />
          <Stat value={stats?.artists ?? 0} label="artists" />
        </div>
        {job.message === null || job.status === "done" ? null : (
          <span className="truncate font-mono text-xs/xs text-text-muted">{job.message}</span>
        )}
      </div>
      <Button variant="solid" size="lg" onClick={() => void navigate({ to: "/" })}>
        Open my library
      </Button>
    </AuthLayout>
  );
}

function Stat({ value, label }: { readonly value: number; readonly label: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="font-mono text-md/base text-text">{formatCount(value)}</span>
      <span className="font-sans text-sm/xs text-text-muted">{label}</span>
    </div>
  );
}

function ScanFailed({ job, path }: { readonly job: Job; readonly path: string }) {
  const navigate = useNavigate();
  const rescan = useRun("libraries.scan");
  const [pending, setPending] = useState(false);

  const resume = async () => {
    if (job.libraryId === null) return;

    setPending(true);

    try {
      const result = await rescan({ libraryId: job.libraryId });
      await navigate({ to: "/setup", search: { step: "scan", jobId: result.jobId } });
    } catch (cause) {
      toastFailure(cause);
    } finally {
      setPending(false);
    }
  };

  return (
    <AuthLayout eyebrow="STEP 3 OF 3">
      <AuthHeading
        title="The scan stopped"
        lead={`${plural(job.done, "song")} were added before it stopped. Nothing was lost; the scan resumes where it stopped.`}
      />
      <div className="flex flex-col gap-2 rounded-md border border-border px-4 py-3.5">
        <div className="flex items-center gap-2.5">
          <span aria-hidden className="size-2 shrink-0 rounded-full bg-danger" />
          <span className="font-sans text-base/sm font-medium text-text">
            {job.status === "cancelled"
              ? "The scan was cancelled"
              : `${path} is no longer readable`}
          </span>
        </div>
        <span className="font-mono text-xs/xs text-text-muted">
          {[job.error, `job ${job.id}`, job.finishedAt === null ? null : formatTime(job.finishedAt)]
            .filter((part) => part !== null)
            .join(" · ")}
        </span>
      </div>
      <div className="flex gap-2.5">
        <Button
          variant="solid"
          size="lg"
          className="grow"
          pending={pending}
          onClick={() => void resume()}
        >
          Resume scan
        </Button>
        <Button
          variant="outline"
          size="lg"
          className="font-medium"
          onClick={() => void navigate({ to: "/" })}
        >
          Use what's there
        </Button>
      </div>
    </AuthLayout>
  );
}
