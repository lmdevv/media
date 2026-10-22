import { argsDecoder } from "@music/commands/codec";
import type { JobId } from "@music/commands/ids";
import { missingFields, outcomeOf, rawArgs } from "@music/commands/forms";
import type { FieldSpec, FormValues } from "@music/commands/forms";
import { capabilityLabel } from "@music/commands/permissions";
import { commands } from "@music/commands/registry";
import type { MutationName } from "@music/commands/registry";
import { usePlayerPosition } from "@music/player/react";
import { makeMusicClient } from "@music/sdk/client";
import { useRead } from "@music/sdk/react";
import { Button } from "@music/ui/components/button";
import { useNavigate } from "@tanstack/react-router";
import { useConvex } from "convex/react";
import { Result } from "effect";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { ProgressBar } from "@/components/auth/scan-progress";
import { jobPercent } from "@/lib/job-progress";
import { describeFailure, toastFailure } from "@/lib/action";
import { copyText } from "@/lib/copy-text";
import { formatCount } from "@/lib/format";

import { ArgsForm } from "./args-form";
import type { MenuContext } from "./args-form";
import { useCommandDefaults } from "./command-defaults";
import { cliOf } from "./items";
import { jobMeta } from "./outcome";
import { PreviewFrame, PreviewTitle, usePrimary } from "./preview-frame";
import type { PreviewProps } from "./preview-frame";

const listFormat = new Intl.ListFormat("en", { type: "conjunction" });

/** The outcome shown in the preview after a command that has one worth showing. */
type Outcome =
  | { readonly kind: "job"; readonly jobId: JobId; readonly title: string }
  | { readonly kind: "key"; readonly key: string }
  | { readonly kind: "invite" | "reset"; readonly link: string };

/** How the preview presents a secret a command returned once. */
const SECRET_COPY = {
  key: { title: "Copy your new key", meta: "This is the only time it's shown." },
  invite: { title: "Share the invite link", meta: "It works once and expires in 7 days." },
  reset: {
    title: "Share the reset link",
    meta:
      "It works once, expires in 24 hours, and signs them out everywhere else. " +
      "Signing in with the new password also turns off this person's API keys.",
  },
} as const;

/** What {@link CommandPreview} takes. */
type CommandPreviewProps = PreviewProps & {
  readonly name: MutationName;
  readonly fields: ReadonlyArray<FieldSpec>;
  readonly context: MenuContext;
};

/**
 * A registry command's preview: its form, the same command for a terminal, and Run. After a run
 * it shows the job, key, or invite the command returned, opens a new playlist, or closes the menu.
 */
export function CommandPreview(props: CommandPreviewProps) {
  return props.name === "playback.seek" ? (
    <SeekPreview {...props} />
  ) : (
    <CommandForm {...props} positionMs={null} />
  );
}

/**
 * The seek command's preview. Only it follows the playback position (several updates a second),
 * so its default target stays current without re-rendering any other command's form.
 */
function SeekPreview(props: CommandPreviewProps) {
  const position = usePlayerPosition();

  return <CommandForm {...props} positionMs={position} />;
}

function CommandForm({
  name,
  fields,
  context,
  onClose,
  onBack,
  registerPrimary,
  positionMs,
}: CommandPreviewProps & { readonly positionMs: number | null }) {
  const convex = useConvex();
  const client = useMemo(() => makeMusicClient(convex), [convex]);
  const navigate = useNavigate();
  const defaults = useCommandDefaults(name, fields, positionMs);
  // Only fields the person changed are kept; the rest follow live defaults such as the current song.
  const [edits, setEdits] = useState<FormValues>({});
  const values: FormValues = { ...defaults, ...edits };
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const command = commands[name];

  const run = async () => {
    const missing = missingFields(fields, values);

    if (missing.length > 0) {
      const names = listFormat.format(missing.map((field) => field.label));
      setError(`${names} ${missing.length === 1 ? "is" : "are"} required.`);

      return;
    }

    const decoded = argsDecoder(name)(rawArgs(fields, values));

    if (Result.isFailure(decoded)) {
      setError(`Check the fields: ${decoded.failure.message}`);

      return;
    }

    setPending(true);
    setError(null);

    try {
      const result = outcomeOf(await client.run(name, decoded.success));

      switch (result.kind) {
        case "job":
          setOutcome({ kind: "job", jobId: result.jobId, title: command.summary });
          break;
        case "key":
          setOutcome({ kind: "key", key: result.key });
          break;
        case "invite":
          setOutcome({ kind: "invite", link: `${window.location.origin}/invite/${result.code}` });
          break;
        case "reset":
          setOutcome({ kind: "reset", link: `${window.location.origin}/reset/${result.token}` });
          break;
        case "playlist":
          onClose();
          await navigate({
            to: "/playlists/$playlistId",
            params: { playlistId: result.playlistId },
          });
          toast.success("Created the playlist");
          break;
        case "none":
          onClose();

          if (command.group !== "playback" && command.group !== "queue")
            toast.success(`Done: ${command.summary}`);

          break;
      }
    } catch (cause) {
      setError(describeFailure(cause));
    } finally {
      setPending(false);
    }
  };

  usePrimary(registerPrimary, () => void run());

  if (outcome !== null)
    return <OutcomePreview outcome={outcome} onClose={onClose} onBack={onBack} />;

  return (
    <PreviewFrame onBack={onBack}>
      <div className="flex flex-col gap-1">
        <span className="font-mono text-xs/xs tracking-mono text-text-muted uppercase">
          {command.group}
          {command.access === "user" ? "" : ` · ${capabilityLabel(command.access)}`}
        </span>
        <h2 className="font-sans text-xl/xl font-heavy tracking-tight text-text">
          {command.summary}
        </h2>
      </div>
      {fields.length === 0 ? null : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void run();
          }}
        >
          <ArgsForm
            fields={fields}
            values={values}
            context={context}
            onChange={(field, value) => setEdits((current) => ({ ...current, [field]: value }))}
          />
          <button type="submit" hidden />
        </form>
      )}
      {error === null ? null : (
        <p role="alert" className="font-sans text-sm/sm text-danger">
          {error}
        </p>
      )}
      <div className="flex flex-col gap-1.5 rounded-md bg-surface px-3.5 py-3">
        <span className="font-sans text-xs/xs font-semibold text-text-muted">
          Same command in a terminal
        </span>
        <code className="font-mono text-sm/xs text-text">{cliOf(name)}</code>
      </div>
      <div className="flex gap-2">
        <Button variant="solid" size="sm" pending={pending} onClick={() => void run()}>
          {pending ? "Running…" : "Run"}
        </Button>
      </div>
    </PreviewFrame>
  );
}

function OutcomePreview({
  outcome,
  onClose,
  onBack,
}: {
  readonly outcome: Outcome;
  readonly onClose: () => void;
  readonly onBack: () => void;
}) {
  const navigate = useNavigate();
  const [copied, setCopied] = useState(false);

  if (outcome.kind === "job")
    return (
      <JobOutcome jobId={outcome.jobId} title={outcome.title} onClose={onClose} onBack={onBack} />
    );

  const value = outcome.kind === "key" ? outcome.key : outcome.link;

  const copy = async () => {
    if (await copyText(value)) setCopied(true);
    else toast.error("Couldn't copy. Select it and copy it yourself.");
  };

  return (
    <PreviewFrame onBack={onBack}>
      <PreviewTitle title={SECRET_COPY[outcome.kind].title} meta={SECRET_COPY[outcome.kind].meta} />
      <div className="flex h-12 items-center gap-2.5 rounded-sm bg-surface pr-1.5 pl-3.5">
        <code className="min-w-0 grow truncate font-mono text-sm/xs text-text select-all">
          {value}
        </code>
        <Button
          variant="solid"
          size="sm"
          className="h-9 rounded-sm px-3"
          onClick={() => void copy()}
        >
          {copied ? <CheckIcon strokeWidth={2} /> : <CopyIcon />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <div className="flex gap-2">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            onClose();
            void navigate({ to: outcome.kind === "key" ? "/settings/keys" : "/settings/people" });
          }}
        >
          {outcome.kind === "key" ? "Open API keys" : "Open People"}
        </Button>
      </div>
    </PreviewFrame>
  );
}

function JobOutcome({
  jobId,
  title,
  onClose,
  onBack,
}: {
  readonly jobId: JobId;
  readonly title: string;
  readonly onClose: () => void;
  readonly onBack: () => void;
}) {
  const job = useRead("jobs.get", { jobId });
  const libraries = useRead("libraries.list", {});
  const navigate = useNavigate();
  const cancel = useRunCancel();
  const path = libraries?.find((library) => library.id === job?.libraryId)?.path;
  const percent = job === undefined ? 0 : (jobPercent(job) ?? 0);
  const active = job !== undefined && (job.status === "running" || job.status === "pending");

  return (
    <PreviewFrame onBack={onBack}>
      <PreviewTitle title={path === undefined ? title : `Scanning ${path}`} meta={jobMeta(job)} />
      <div className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between">
          <span className="font-sans text-2xl/2xl font-heavy tracking-display text-text">
            {percent}%
          </span>
          <span className="font-mono text-xs/xs text-text-muted">
            {job === undefined || job.total === null || (job.status === "done" && job.total === 0)
              ? job?.status === "pending"
                ? "WAITING"
                : ""
              : `${formatCount(job.done)} / ${formatCount(job.total)}`}
          </span>
        </div>
        <ProgressBar percent={percent} label={title} />
      </div>
      <div className="flex gap-2">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            onClose();
            void navigate({ to: "/settings/jobs" });
          }}
        >
          Open Jobs
        </Button>
        {active ? (
          <Button variant="ghost" size="sm" onClick={() => cancel(jobId)}>
            Cancel scan
          </Button>
        ) : null}
      </div>
    </PreviewFrame>
  );
}

const useRunCancel = (): ((jobId: JobId) => void) => {
  const convex = useConvex();
  const client = useMemo(() => makeMusicClient(convex), [convex]);

  return (jobId) => {
    client
      .run("jobs.cancel", { jobId })
      .then(() => toast.success("Cancelled the scan"))
      .catch(toastFailure);
  };
};
