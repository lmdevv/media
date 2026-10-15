/**
 * Human-readable output. Results are rendered by walking the command's result schema next to the
 * value, so lists of known models become compact tables and everything else becomes key-value
 * lines. `--json` bypasses this module.
 */
import {
  AlbumCard,
  ApiKey,
  ArtistCard,
  Device,
  DirectoryPerson,
  HistoryEntry,
  Invite,
  JamMember,
  Job,
  Library,
  LibraryMember,
  Person,
  Playlist,
  PlaylistEntry,
  PlaylistShare,
  QueueEntry,
  Track,
  User,
} from "@music/commands/models";
import { Predicate, SchemaAST } from "effect";
import type { Schema } from "effect";

import { escapeControlCharacters } from "./escape";

type Json = Schema.Json;

/** One table column: a header and how to read its cell from a row. */
interface Column {
  readonly header: string;
  readonly cell: (row: Schema.JsonObject) => string;
}

const isJsonArray = (value: Json): value is Schema.JsonArray => Array.isArray(value);

const isJsonObject = (value: Json): value is Schema.JsonObject =>
  Predicate.isObject(value) && !Array.isArray(value);

const pad = (part: number): string => String(part).padStart(2, "0");

/** `61_000` → `1:01`; `3_723_000` → `1:02:03`. */
export const formatDuration = (ms: number): string => {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = pad(total % 60);

  return hours > 0
    ? `${String(hours)}:${pad(minutes)}:${seconds}`
    : `${String(minutes)}:${seconds}`;
};

/** Epoch milliseconds → `2026-10-10 14:05` in local time. */
export const formatTimestamp = (ms: number): string => {
  const date = new Date(ms);

  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

const formatNumber = (key: string, value: number): string => {
  if (key.endsWith("Ms")) return formatDuration(value);

  if (key.endsWith("At")) return formatTimestamp(value);

  if (key === "volume") return `${String(Math.round(value * 100))}%`;

  return Number.isInteger(value) ? String(value) : value.toFixed(2);
};

/** Formats a scalar by its field name: durations, timestamps, booleans, and nulls. */
const formatScalar = (key: string, value: Json): string => {
  if (value === null) return "-";

  if (Predicate.isBoolean(value)) return value ? "yes" : "no";

  if (Predicate.isNumber(value)) return formatNumber(key, value);

  if (Predicate.isString(value)) return escapeControlCharacters(value);

  return escapeControlCharacters(JSON.stringify(value));
};

/** The value at `path` in a row; null once a step is null (a withheld song shows `-`). */
const at = (row: Schema.JsonObject, path: ReadonlyArray<string>): Json | undefined => {
  let current: Json | undefined = row;

  for (const key of path) {
    if (current === null) return null;

    if (current === undefined || !isJsonObject(current)) return undefined;
    current = current[key];
  }

  return current;
};

const field = (header: string, ...path: ReadonlyArray<string>): Column => ({
  header,
  cell: (row) => {
    const value = at(row, path);

    return value === undefined ? "" : formatScalar(path.at(-1) ?? "", value);
  },
});

const liked: Column = {
  header: "LIKED",
  cell: (row) => (row["liked"] === true ? "♥" : ""),
};

const REASONS = new Map([
  ["missing", "file missing"],
  ["no_access", "no access"],
]);

/**
 * Marks a playlist entry that can't play: its file is gone, or it is in a library you can't
 * listen to. It stays listed so it can be removed.
 */
const unavailable: Column = {
  header: "STATUS",
  cell: (row) => {
    if (row["available"] !== false) return "";
    const reason = row["reason"];

    return (Predicate.isString(reason) ? REASONS.get(reason) : undefined) ?? "unavailable";
  },
};

/** When someone joined a Jam, or asked to. */
const since: Column = {
  header: "SINCE",
  cell: (row) => (Predicate.isNumber(row["since"]) ? formatTimestamp(row["since"]) : ""),
};

/** Marks a queue entry autoplay added. */
const autoplayed: Column = {
  header: "FROM",
  cell: (row) => (row["autoplay"] === true ? "autoplay" : ""),
};

const progress: Column = {
  header: "PROGRESS",
  cell: (row) => {
    const done = row["done"];
    const total = row["total"];

    if (!Predicate.isNumber(done)) return "";

    return Predicate.isNumber(total) ? `${String(done)}/${String(total)}` : String(done);
  },
};

const note: Column = {
  header: "NOTE",
  cell: (row) => {
    const error = row["error"];
    const message = row["message"];

    if (Predicate.isString(error)) return error;

    return Predicate.isString(message) ? message : "";
  },
};

const presets = new Map<SchemaAST.AST, ReadonlyArray<Column>>([
  [
    Track.ast,
    [
      field("ID", "id"),
      field("TITLE", "title"),
      field("ARTIST", "artist"),
      field("ALBUM", "album"),
      field("TIME", "durationMs"),
      liked,
    ],
  ],
  [
    AlbumCard.ast,
    [
      field("ID", "id"),
      field("TITLE", "title"),
      field("ARTIST", "artist"),
      field("YEAR", "year"),
      field("SONGS", "trackCount"),
    ],
  ],
  [ArtistCard.ast, [field("ID", "id"), field("NAME", "name"), field("ALBUMS", "albumCount")]],
  [
    Playlist.ast,
    [
      field("ID", "id"),
      field("NAME", "name"),
      field("SONGS", "trackCount"),
      field("TIME", "durationMs"),
      field("OWNER", "owner", "name"),
      field("ACCESS", "access"),
      field("UPDATED", "updatedAt"),
    ],
  ],
  [
    PlaylistEntry.ast,
    [
      field("ITEM", "itemId"),
      field("TRACK", "track", "id"),
      field("TITLE", "track", "title"),
      field("ARTIST", "track", "artist"),
      field("TIME", "durationMs"),
      field("ADDED BY", "addedBy", "name"),
      unavailable,
    ],
  ],
  [
    QueueEntry.ast,
    [
      field("ITEM", "itemId"),
      field("TRACK", "id"),
      field("TITLE", "title"),
      field("ARTIST", "artist"),
      field("TIME", "durationMs"),
      field("ADDED BY", "addedBy", "name"),
      autoplayed,
    ],
  ],
  [
    PlaylistShare.ast,
    [field("ID", "person", "id"), field("NAME", "person", "name"), field("ROLE", "role")],
  ],
  [DirectoryPerson.ast, [field("ID", "id"), field("NAME", "name"), field("ROLE", "role")]],
  [
    JamMember.ast,
    [
      field("ID", "person", "id"),
      field("NAME", "person", "name"),
      field("STATUS", "status"),
      field("LISTENING", "listening"),
      since,
    ],
  ],
  [
    HistoryEntry.ast,
    [
      field("PLAYED", "playedAt"),
      field("TRACK", "track", "id"),
      field("TITLE", "track", "title"),
      field("ARTIST", "track", "artist"),
    ],
  ],
  [
    Device.ast,
    [
      field("ID", "id"),
      field("NAME", "name"),
      field("KIND", "kind"),
      field("ONLINE", "online"),
      field("LAST SEEN", "lastSeenAt"),
    ],
  ],
  [
    Job.ast,
    [field("ID", "id"), field("LABEL", "label"), field("STATUS", "status"), progress, note],
  ],
  [
    Library.ast,
    [
      field("ID", "id"),
      field("NAME", "name"),
      field("PATH", "path"),
      field("VISIBILITY", "visibility"),
      field("OWNER", "ownerName"),
      field("SONGS", "trackCount"),
      field("SCANNING", "scanning"),
      field("LAST SCAN", "lastScanAt"),
    ],
  ],
  [
    ApiKey.ast,
    [
      field("ID", "id"),
      field("NAME", "name"),
      field("PREFIX", "prefix"),
      field("CREATED", "createdAt"),
      field("LAST USED", "lastUsedAt"),
    ],
  ],
  [
    Invite.ast,
    [
      field("ID", "id"),
      field("CODE", "code"),
      field("EMAIL", "email"),
      field("ROLE", "role"),
      field("STATUS", "status"),
      field("EXPIRES", "expiresAt"),
      field("ACCEPTED", "acceptedAt"),
    ],
  ],
  [
    User.ast,
    [field("ID", "id"), field("EMAIL", "email"), field("NAME", "name"), field("ROLE", "role")],
  ],
  [
    Person.ast,
    [
      field("ID", "id"),
      field("EMAIL", "email"),
      field("NAME", "name"),
      field("ROLE", "role"),
      field("SUSPENDED", "suspended"),
      field("LAST ACTIVE", "lastActiveAt"),
    ],
  ],
  [
    LibraryMember.ast,
    [field("ID", "id"), field("EMAIL", "email"), field("NAME", "name"), field("ROLE", "role")],
  ],
]);

const maxCell = 48;

const clip = (text: string): string => {
  const flat = text.replaceAll(/\s+/gu, " ");

  return flat.length > maxCell ? `${flat.slice(0, maxCell - 1)}…` : flat;
};

/** Renders rows as an aligned table with an uppercase header. */
const table = (
  columns: ReadonlyArray<Column>,
  rows: ReadonlyArray<Schema.JsonObject>,
): ReadonlyArray<string> => {
  const cells = rows.map((row) => columns.map((column) => clip(column.cell(row))));

  const widths = columns.map((column, index) =>
    Math.max(column.header.length, ...cells.map((row) => row[index]?.length ?? 0)),
  );

  const line = (parts: ReadonlyArray<string>): string =>
    parts
      .map((part, index) =>
        index === parts.length - 1 ? part : part.padEnd(widths[index] ?? part.length),
      )
      .join("  ")
      .trimEnd();

  return [line(columns.map((column) => column.header)), ...cells.map(line)];
};

/** `trackCount` → `track count`, `durationMs` → `duration`. */
const label = (key: string): string =>
  key
    .replace(/Ms$/u, "")
    .replaceAll(/[A-Z]/gu, (letter) => ` ${letter.toLowerCase()}`)
    .trim();

const isScalar = (value: Json): boolean => !isJsonArray(value) && !isJsonObject(value);

const genericColumns = (rows: ReadonlyArray<Schema.JsonObject>): ReadonlyArray<Column> => {
  const [first] = rows;

  if (first === undefined) return [];

  return Object.entries(first)
    .filter(([, value]) => isScalar(value))
    .map(([key]) => field(label(key).toUpperCase(), key));
};

/** Strips `NullOr` and other unions down to the member that describes a present value. */
const presentMember = (ast: SchemaAST.AST): SchemaAST.AST => {
  if (!SchemaAST.isUnion(ast)) return ast;

  const members = ast.types.filter((member) => !SchemaAST.isNull(member));
  const [only] = members;

  return members.length === 1 && only !== undefined ? presentMember(only) : ast;
};

const indent = (lines: ReadonlyArray<string>): ReadonlyArray<string> =>
  lines.map((line) => `  ${line}`);

const renderArray = (ast: SchemaAST.AST, items: Schema.JsonArray): ReadonlyArray<string> => {
  if (items.length === 0) return ["(none)"];

  const element = SchemaAST.isArrays(ast) ? ast.rest[0] : undefined;
  const preset = element === undefined ? undefined : presets.get(presentMember(element));
  const rows = items.filter(isJsonObject);

  if (rows.length !== items.length) return items.map((item) => formatScalar("", item));

  return table(preset ?? genericColumns(rows), rows);
};

const propertyType = (ast: SchemaAST.AST, key: string): SchemaAST.AST | undefined =>
  SchemaAST.isObjects(ast)
    ? ast.propertySignatures.find((property) => property.name === key)?.type
    : undefined;

const renderObject = (ast: SchemaAST.AST, value: Schema.JsonObject): ReadonlyArray<string> => {
  const lines: Array<string> = [];

  for (const [key, item] of Object.entries(value)) {
    const itemAst = presentMember(propertyType(ast, key) ?? SchemaAST.unknown);

    if (isJsonArray(item) && item.length > 0) {
      lines.push(`${label(key)}:`, ...indent(renderArray(itemAst, item)));
    } else if (isJsonArray(item)) {
      lines.push(`${label(key)}: (none)`);
    } else if (isJsonObject(item)) {
      lines.push(`${label(key)}:`, ...indent(renderObject(itemAst, item)));
    } else {
      lines.push(`${label(key)}: ${formatScalar(key, item)}`);
    }
  }

  return lines;
};

/** A cursor page (`items`, `cursor`, `done`) prints as its table plus the flag for the next page. */
const renderPage = (ast: SchemaAST.AST, value: Schema.JsonObject): string | null => {
  const { items, cursor, done } = value;

  if (items === undefined || !isJsonArray(items) || !Predicate.isString(cursor)) return null;

  if (!Predicate.isBoolean(done) || Object.keys(value).length !== 3) return null;

  const lines = renderArray(presentMember(propertyType(ast, "items") ?? SchemaAST.unknown), items);

  return [...lines, ...(done ? [] : [`More: --cursor ${cursor}`])].join("\n");
};

/** Renders a decoded command result for people. */
export const renderResult = (schema: Schema.Top, value: Json): string => {
  const ast = presentMember(schema.ast);

  if (isJsonArray(value)) return renderArray(ast, value).join("\n");

  if (isJsonObject(value)) {
    const keys = Object.keys(value);

    if (keys.length === 1 && value["ok"] === true) return "ok";

    const page = renderPage(ast, value);

    if (page !== null) return page;

    return renderObject(ast, value).join("\n");
  }

  return formatScalar("", value);
};
