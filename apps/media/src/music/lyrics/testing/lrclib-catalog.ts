/**
 * A stand-in for LRCLIB's catalog that answers any song, the same way every time: test code, used
 * by the server's tests, the live lanes, and the perf runs (`fake-lrclib-main.ts`), against old
 * music and the server alike. A song's answer follows from its title's hash, so a run and its
 * rerun, or old music and the port, see the same catalog: one in six has no record, one in six is
 * instrumental, one in six has plain lyrics only, and the rest have synced lyrics. Plain
 * TypeScript, so Node runs it without a build.
 */
import { createHash } from "node:crypto";

/** One request as the catalog reads it. */
export interface CatalogRequest {
  readonly path: string;
  readonly params: Readonly<Record<string, string>>;
}

/** How the catalog answers one request. */
export interface CatalogReply {
  readonly status: number;
  readonly body: string;
}

/** What LRCLIB holds for a song in this catalog. */
export type CatalogAnswer = "miss" | "instrumental" | "plain" | "synced";

const ANSWERS: ReadonlyArray<CatalogAnswer> = [
  "miss",
  "instrumental",
  "plain",
  "synced",
  "synced",
  "synced",
];

/** The catalog's answer for a song titled `title`. */
export const catalogAnswer = (title: string): CatalogAnswer => {
  const digest = createHash("sha256").update(title.trim().toLowerCase()).digest();

  return ANSWERS[(digest[0] ?? 0) % ANSWERS.length] ?? "synced";
};

const recordId = (title: string): number =>
  (createHash("sha256").update(title).digest().readUInt32BE(0) % 9_000_000) + 1;

/** A value as JSON carries it. */
type Json =
  | string
  | number
  | boolean
  | null
  | ReadonlyArray<Json>
  | { readonly [key: string]: Json };

const json = (status: number, value: Json): CatalogReply => ({
  status,
  body: JSON.stringify(value),
});

const NOT_FOUND = json(404, {
  message: "Failed to find specified track",
  name: "TrackNotFound",
  statusCode: 404,
});

/** The synced lyrics the catalog holds for a song: three timed lines naming it. */
const syncedLyricsOf = (title: string): string =>
  [`[00:01.00]${title}, line one`, `[00:05.50]${title}, line two`, `[00:10.25]${title}, end`].join(
    "\n",
  );

const recordOf = (params: Readonly<Record<string, string>>, title: string) => {
  const answer = catalogAnswer(title);

  return {
    id: recordId(title),
    name: title,
    trackName: title,
    artistName: params["artist_name"] ?? "",
    albumName: params["album_name"] ?? "",
    duration: Number(params["duration"] ?? "0"),
    instrumental: answer === "instrumental",
    plainLyrics: answer === "plain" || answer === "synced" ? `${title}\nIn plain words` : null,
    syncedLyrics: answer === "synced" ? syncedLyricsOf(title) : null,
  };
};

/**
 * LRCLIB's answer to `request`: `/api/get` answers the song's record or 404, and `/api/search`
 * answers the record in a list, or an empty one. Anything else is 404.
 */
export const catalogReply = (request: CatalogRequest): CatalogReply => {
  const title = request.params["track_name"] ?? "";

  if (title === "" || catalogAnswer(title) === "miss") {
    return request.path === "/api/search" ? json(200, []) : NOT_FOUND;
  }

  if (request.path === "/api/get") return json(200, recordOf(request.params, title));

  if (request.path === "/api/search") {
    // A search names no duration; LRCLIB's search results carry the record's own.
    return json(200, [{ ...recordOf(request.params, title), duration: 0 }]);
  }

  return NOT_FOUND;
};
