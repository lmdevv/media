import { ApiKey, Invite, SessionInfo, User } from "@media/contracts/models/account";
import {
  ContinueWatchingItem,
  Episode,
  HistoryEntry,
  Library,
  LibraryDetail,
  TitleCard,
} from "@media/contracts/models/catalog";
import { Backup, Job } from "@media/contracts/models/jobs";
import { PlaybackSession } from "@media/contracts/models/playback";
import { Profile } from "@media/contracts/models/profiles";
import { RoomMember } from "@media/contracts/models/rooms";
import { Predicate, SchemaAST } from "effect";
import type { Schema } from "effect";

type Json = Schema.Json;

interface Column {
  readonly header: string;
  readonly cell: (row: Schema.JsonObject) => string;
}

const isJsonArray = (value: Json): value is Schema.JsonArray => Array.isArray(value);

const isJsonObject = (value: Json): value is Schema.JsonObject =>
  Predicate.isObject(value) && !Array.isArray(value);

const pad = (part: number): string => String(part).padStart(2, "0");

/** An episode as the CLI names it: `S1E2 The Name`. */
export const episodeLabel = (episode: {
  readonly seasonNumber: number;
  readonly episodeNumber: number;
  readonly name: string;
}): string => `S${String(episode.seasonNumber)}E${String(episode.episodeNumber)} ${episode.name}`;

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

const formatTimestamp = (ms: number): string => {
  const date = new Date(ms);

  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

const formatNumber = (key: string, value: number): string => {
  if (key.endsWith("Ms")) return formatDuration(value);

  if (key.endsWith("At")) return formatTimestamp(value);

  return Number.isInteger(value) ? String(value) : value.toFixed(2);
};

const formatScalar = (key: string, value: Json): string => {
  if (value === null) return "-";

  if (Predicate.isBoolean(value)) return value ? "yes" : "no";

  if (Predicate.isNumber(value)) return formatNumber(key, value);

  if (Predicate.isString(value)) return value;

  return JSON.stringify(value);
};

const at = (row: Schema.JsonObject, path: ReadonlyArray<string>): Json | undefined => {
  let current: Json | undefined = row;

  for (const key of path) {
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

const titleColumns = [
  field("ID", "id"),
  field("NAME", "name"),
  field("KIND", "kind"),
  field("YEAR", "year"),
  field("RATING", "certification"),
  field("RUNTIME", "runtimeMs"),
];

const libraryColumns = [
  field("ID", "id"),
  field("NAME", "name"),
  field("KIND", "kind"),
  field("TITLES", "titleCount"),
  field("SCANNING", "scanning"),
  field("LAST SCAN", "lastScanAt"),
];

const presets = new Map<SchemaAST.AST, ReadonlyArray<Column>>([
  [TitleCard.ast, titleColumns],
  [
    Episode.ast,
    [
      field("ID", "id"),
      field("SEASON", "seasonNumber"),
      field("EPISODE", "episodeNumber"),
      field("NAME", "name"),
      field("RUNTIME", "runtimeMs"),
      field("WATCHED", "progress", "watched"),
    ],
  ],
  [
    ContinueWatchingItem.ast,
    [
      field("TITLE", "title", "name"),
      field("TITLE ID", "title", "id"),
      field("REASON", "reason"),
      field("SEASON", "episode", "seasonNumber"),
      field("EPISODE", "episode", "episodeNumber"),
      field("AT", "progress", "positionMs"),
    ],
  ],
  [
    HistoryEntry.ast,
    [
      field("PLAYED", "lastPlayedAt"),
      field("TITLE", "title", "name"),
      field("SEASON", "episode", "seasonNumber"),
      field("EPISODE", "episode", "episodeNumber"),
      field("AT", "progress", "positionMs"),
      field("WATCHED", "progress", "watched"),
    ],
  ],
  [Library.ast, libraryColumns],
  [LibraryDetail.ast, [...libraryColumns, field("ACCESS", "access")]],
  [Job.ast, [field("ID", "id"), field("KIND", "kind"), field("STATUS", "status"), progress, note]],
  [
    ApiKey.ast,
    [
      field("ID", "id"),
      field("NAME", "name"),
      field("PREFIX", "prefix"),
      field("CREATED", "createdAt"),
      field("LAST USED", "lastUsedAt"),
      field("REVOKED", "revokedAt"),
    ],
  ],
  [
    Invite.ast,
    [
      field("ID", "id"),
      field("EMAIL", "email"),
      field("ROLE", "role"),
      field("STATE", "state"),
      field("EXPIRES", "expiresAt"),
    ],
  ],
  [
    User.ast,
    [
      field("ID", "id"),
      field("EMAIL", "email"),
      field("NAME", "name"),
      field("ROLE", "role"),
      field("DISABLED", "disabled"),
    ],
  ],
  [
    Profile.ast,
    [
      field("ID", "id"),
      field("NAME", "name"),
      field("KIDS", "kids"),
      field("MAX AGE", "maxAgeRating"),
      field("PIN", "hasPin"),
      field("LOCKED", "locked"),
    ],
  ],
  [
    SessionInfo.ast,
    [
      field("ID", "id"),
      field("KIND", "kind"),
      field("LABEL", "label"),
      field("CREATED", "createdAt"),
      field("CURRENT", "current"),
    ],
  ],
  [
    Backup.ast,
    [
      field("ID", "id"),
      field("FILE", "fileName"),
      field("TRIGGER", "trigger"),
      field("CREATED", "createdAt"),
    ],
  ],
  [
    PlaybackSession.ast,
    [
      field("DEVICE", "deviceName"),
      field("TITLE", "titleId"),
      field("STATE", "state"),
      field("AT", "positionMs"),
      field("MODE", "mode"),
    ],
  ],
  [
    RoomMember.ast,
    [
      field("PROFILE", "profileName"),
      field("ROLE", "role"),
      field("DEVICE", "deviceId"),
      field("PRESENCE", "presence"),
      field("LAST SEEN", "lastSeenAt"),
    ],
  ],
]);

const maxCell = 48;

const clip = (text: string): string => {
  const flat = text.replaceAll(/\s+/gu, " ");

  return flat.length > maxCell ? `${flat.slice(0, maxCell - 1)}…` : flat;
};

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

const renderPage = (ast: SchemaAST.AST, value: Schema.JsonObject): string | null => {
  const { items, nextCursor } = value;

  if (items === undefined || !isJsonArray(items) || Object.keys(value).length !== 2) return null;

  if (nextCursor !== null && !Predicate.isString(nextCursor)) return null;

  const lines = renderArray(presentMember(propertyType(ast, "items") ?? SchemaAST.unknown), items);

  return [...lines, ...(nextCursor === null ? [] : [`More: --cursor ${nextCursor}`])].join("\n");
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
