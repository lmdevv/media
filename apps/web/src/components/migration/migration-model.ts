import type { MigrationSource } from "@media/contracts/models/jobs";
import type { MigrationPhase } from "@media/contracts/models/migration";

/** What the Importing screen says each phase is doing. */
export const PHASE_LABELS: Readonly<Record<MigrationPhase, string>> = {
  libraries: "Adding libraries",
  scanning: "Scanning new folders",
  watchState: "Watched status",
  collections: "Collections",
  overrides: "Title and artwork edits",
  done: "Finishing",
};

/**
 * What the admin typed on Connect. It stays in the page's memory only, so Review can reconnect
 * with new folder mappings and Back returns to a filled form.
 */
export interface SourceForm {
  readonly source: MigrationSource;
  readonly url: string;
  /** A Jellyfin API key or a Plex token. Never stored, logged, or put in the URL. */
  readonly token: string;
}

/** An empty Connect form for Jellyfin. */
export const EMPTY_FORM: SourceForm = { source: "jellyfin", url: "", token: "" };
