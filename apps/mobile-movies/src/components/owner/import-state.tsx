import type { MigrationSource } from "@media/contracts/models/jobs";
import type {
  ImportConnection,
  ImportReport,
  ImportUserMapping,
  MigrationSourceFailure,
  PathMapping,
} from "@media/contracts/models/migration";
import { mappingsWith } from "@media/contracts/migration-plan";
import { useHousehold } from "@media/mobile-core/use-accounts";
import { Option, Redacted } from "effect";
import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";

import { mappingsFor, userRows } from "@/lib/migration";
import type { UserChoice, UserRow } from "@/lib/migration";
import { useMediaServer } from "@/session/media-server";

import { useTask } from "./use-task";

/** What Connect holds. */
export interface SourceForm {
  readonly source: MigrationSource;
  readonly url: string;
  /** A Jellyfin API key or a Plex token. Never stored or logged. */
  readonly token: string;
}

/** A connected source and its dry run. */
export interface Preview {
  readonly connection: ImportConnection;
  readonly report: ImportReport;
}

interface ImportState {
  readonly form: SourceForm;
  readonly setForm: (form: SourceForm) => void;
  readonly preview: Preview | null;
  readonly setPreview: (preview: Preview | null) => void;
}

const ImportContext = createContext<ImportState | null>(null);

/** Holds the import flow's state for the screens inside it. */
export function ImportProvider({ children }: { readonly children: ReactNode }) {
  const [form, setForm] = useState<SourceForm>({ source: "jellyfin", url: "", token: "" });
  const [preview, setPreview] = useState<Preview | null>(null);

  const value = useMemo(
    (): ImportState => ({ form, setForm, preview, setPreview }),
    [form, preview],
  );

  return <ImportContext.Provider value={value}>{children}</ImportContext.Provider>;
}

/**
 * The import flow's state.
 *
 * @throws When used outside `ImportProvider`, a programming error.
 */
export const useImportState = (): ImportState => {
  const state = useContext(ImportContext);

  if (state === null) throw new Error("useImportState must be used inside ImportProvider");

  return state;
};

/** A connected source and its dry run, or why the source could not be used. */
export type PreviewResult = ({ readonly status: "ready" } & Preview) | MigrationSourceFailure;

/**
 * Connects to the source in `form` and dry-runs the import. `users` overrides suggested mappings;
 * `pathMappings` adds folder mappings. Failures of this server itself, such as a missing scope,
 * reject; a source that cannot be used resolves with its reason.
 */
export const usePreview = () => {
  const media = useMediaServer();

  return useCallback(
    async (
      form: SourceForm,
      options: {
        readonly users?: ReadonlyArray<ImportUserMapping>;
        readonly pathMappings?: ReadonlyArray<PathMapping>;
      } = {},
    ): Promise<PreviewResult> => {
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

/**
 * Review's user rows for `preview`, and the changes that run the dry run again: where a source
 * user's history goes, and where a source folder is on this server.
 */
export const useReview = (preview: Preview) => {
  const { form, setPreview } = useImportState();
  const people = useHousehold();
  const media = useMediaServer();
  const reconnect = usePreview();
  const { connection, report } = preview;

  const rows: ReadonlyArray<UserRow> = useMemo(
    () => userRows(connection, report, people.status === "ready" ? people.rows : []),
    [connection, report, people],
  );

  const settle = (result: PreviewResult): MigrationSourceFailure | null => {
    if (result.status === "failed") return result;
    setPreview({ connection: result.connection, report: result.report });

    return null;
  };

  const choose = useTask(async (sourceUserId: string, choice: UserChoice) => {
    const next = await media.run("imports.preview", {
      connectionId: connection.connectionId,
      users: mappingsFor(rows, { sourceUserId, choice }),
    });

    const failure = settle(
      next.status === "failed" ? next : { status: "ready", connection, report: next },
    );

    if (failure !== null) throw new Error(failure.message);
  });

  const map = async (from: string, to: string): Promise<boolean> => {
    const mappings = mappingsWith(connection.pathMappings, from, to);

    if (Option.isNone(mappings)) return false;

    const failure = settle(
      await reconnect(form, { users: mappingsFor(rows), pathMappings: mappings.value }),
    );

    if (failure !== null) throw new Error(failure.message);

    return true;
  };

  return { rows, choose, map };
};
