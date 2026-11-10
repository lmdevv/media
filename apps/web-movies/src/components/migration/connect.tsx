import type { MigrationSource } from "@media/contracts/models/jobs";
import type {
  ImportConnection,
  ImportReport,
  ImportUserMapping,
  MigrationSourceFailure,
  PathMapping,
} from "@media/contracts/models/migration";
import { Button } from "@media/ui/components/button";
import { PageHeader } from "@media/ui/components/page-header";
import { RadioGroup, RadioItem } from "@media/ui/components/radio-group";
import { FieldError, TextField } from "@media/ui/components/text-field";
import { SOURCE_NAMES, failureLine } from "@media/contracts/migration-plan";
import { Redacted } from "effect";
import { useCallback } from "react";
import type { FormEvent } from "react";

import { useAction } from "@/components/admin/action";
import { useMediaServer } from "@/session/error-reporting";

import type { SourceForm } from "./migration-model";

/** A connected source and its dry run, or why the source could not be used. */
export type Preview =
  | {
      readonly status: "ready";
      readonly connection: ImportConnection;
      readonly report: ImportReport;
    }
  | MigrationSourceFailure;

/**
 * Connects to the source in `form` and dry-runs the import. `users` overrides the suggested
 * mappings (users not listed follow their suggestion); `pathMappings` adds folder mappings. Command failures, such as a missing `admin` scope,
 * reject.
 */
export const usePreview = (): ((
  form: SourceForm,
  options?: {
    readonly users?: ReadonlyArray<ImportUserMapping>;
    readonly pathMappings?: ReadonlyArray<PathMapping>;
  },
) => Promise<Preview>) => {
  const media = useMediaServer();

  return useCallback(
    async (form, options = {}) => {
      const connection = await media.run("imports.connect", {
        source: form.source,
        url: form.url.trim(),
        credentials: { kind: "token", token: Redacted.make(form.token.trim()) },
        pathMappings: options.pathMappings ?? [],
      });

      if (connection.status === "failed") return connection;

      const known = new Set(connection.users.map((user) => user.sourceUserId));
      const users = (options.users ?? []).filter((user) => known.has(user.sourceUserId));

      const report = await media.run("imports.preview", {
        connectionId: connection.connectionId,
        users,
      });

      return report.status === "failed" ? report : { status: "ready", connection, report };
    },
    [media],
  );
};

const URL_PLACEHOLDERS: Readonly<Record<MigrationSource, string>> = {
  jellyfin: "http://jellyfin.local:8096",
  plex: "http://plex.local:32400",
};

const SOURCES: ReadonlyArray<MigrationSource> = ["jellyfin", "plex"];

/**
 * 01 Connect, and 01b Couldn't connect when `failure` is set: the source, its address, and its
 * key. The failure shows under the field it concerns.
 */
export function Connect({
  form,
  failure,
  onFormChange,
  onReady,
  onFailed,
}: {
  readonly form: SourceForm;
  readonly failure: MigrationSourceFailure | null;
  readonly onFormChange: (form: SourceForm) => void;
  readonly onReady: (preview: Extract<Preview, { readonly status: "ready" }>) => void;
  readonly onFailed: (failure: MigrationSourceFailure) => void;
}) {
  const preview = usePreview();
  const { run, pending, error } = useAction(preview, { quiet: true });
  const shown = failure === null ? null : failureLine(failure, form.source);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();

    const result = await run(form);

    if (result === undefined) return;

    if (result.status === "failed") onFailed(result);
    else onReady(result);
  };

  return (
    <>
      <PageHeader title="Import from Jellyfin or Plex" />
      <form onSubmit={(event) => void submit(event)} className="flex w-full max-w-120 flex-col">
        <RadioGroup
          aria-label="Import from"
          value={form.source}
          onValueChange={(value) => {
            const source = SOURCES.find((each) => each === value);

            if (source !== undefined) onFormChange({ ...form, source });
          }}
          className="gap-1"
        >
          {SOURCES.map((each) => (
            <label key={each} className="flex h-11 cursor-pointer items-center gap-3.5">
              <RadioItem value={each} />
              <span className="font-sans text-body/body font-semibold text-text">
                {SOURCE_NAMES[each]}
              </span>
            </label>
          ))}
        </RadioGroup>
        <div className="flex flex-col gap-5 pt-8">
          <TextField
            label="Server URL"
            type="url"
            required
            value={form.url}
            onChange={(event) => onFormChange({ ...form, url: event.target.value })}
            placeholder={URL_PLACEHOLDERS[form.source]}
            error={shown?.field === "url" ? shown.message : undefined}
            className="[&_input]:font-mono [&_input]:text-label/label"
          />
          <div className="flex flex-col gap-2">
            <TextField
              label={form.source === "plex" ? "Plex token" : "API key"}
              type="password"
              required
              autoComplete="off"
              value={form.token}
              onChange={(event) => onFormChange({ ...form, token: event.target.value })}
              error={shown?.field === "token" ? shown.message : undefined}
              className="[&_input]:font-mono [&_input]:text-label/label"
            />
            {form.source === "jellyfin" && shown?.field !== "token" ? (
              <span className="font-sans text-caption/caption text-text-muted">
                Jellyfin › Dashboard › API keys
              </span>
            ) : null}
          </div>
          {error === undefined ? null : <FieldError>{error}</FieldError>}
          <div className="flex pt-3">
            <Button type="submit" size="md" disabled={pending}>
              {pending ? "Connecting…" : "Connect"}
            </Button>
          </div>
        </div>
      </form>
    </>
  );
}
