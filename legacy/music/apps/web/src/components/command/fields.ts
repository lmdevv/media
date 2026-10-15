import { commands } from "@music/commands/registry";
import type { CommandName } from "@music/commands/registry";
import { Option, Schema, SchemaAST } from "effect";

/** Records a command's ID arguments point at; each gets a picker of the matching items. */
export type Entity =
  | "track"
  | "album"
  | "artist"
  | "playlist"
  | "playlistItem"
  | "queueItem"
  | "sharee"
  | "library"
  | "job"
  | "apiKey"
  | "invite"
  | "device"
  | "person";

/** How one argument is edited in the command menu's inline form. */
type FieldKind =
  | { readonly kind: "text"; readonly mono: boolean }
  | {
      readonly kind: "number";
      readonly integer: boolean;
      readonly min: number | null;
      readonly max: number | null;
    }
  | { readonly kind: "boolean" }
  | { readonly kind: "choice"; readonly options: ReadonlyArray<string> }
  | { readonly kind: "id"; readonly entity: Entity }
  | { readonly kind: "ids"; readonly entity: Entity };

/** One argument of a command, read from its registry schema. */
export interface FieldSpec {
  readonly name: string;
  readonly label: string;
  readonly optional: boolean;
  readonly field: FieldKind;
}

/** ID argument names and the records they point at. */
const ENTITIES = new Map<string, Entity>([
  ["trackId", "track"],
  ["trackIds", "track"],
  ["albumId", "album"],
  ["artistId", "artist"],
  ["playlistId", "playlist"],
  ["itemId", "playlistItem"],
  ["libraryId", "library"],
  ["jobId", "job"],
  ["apiKeyId", "apiKey"],
  ["inviteId", "invite"],
  ["deviceId", "device"],
  ["userId", "person"],
]);

/**
 * The record an ID argument points at. `itemId` names a playlist entry in playlist commands and a
 * queue entry elsewhere; people to share with come from the directory, which members can read.
 */
const entityOf = (command: CommandName, name: string): Entity | undefined => {
  const group = commands[command].group;

  if (name === "itemId" || name === "afterItemId") {
    return group === "playlists" ? "playlistItem" : "queueItem";
  }

  if (name === "userId" && group === "playlists") return "sharee";

  return ENTITIES.get(name);
};

/** Labels for fields whose names read poorly when split. */
const LABELS = new Map<string, string>([
  ["trackId", "Song"],
  ["trackIds", "Songs"],
  ["albumId", "Album"],
  ["artistId", "Artist"],
  ["playlistId", "Playlist"],
  ["itemId", "Song"],
  ["afterItemId", "After this song"],
  ["libraryId", "Library folder"],
  ["jobId", "Job"],
  ["apiKeyId", "Key"],
  ["inviteId", "Invite"],
  ["deviceId", "Device"],
  ["userId", "Person"],
  ["positionMs", "Position in milliseconds"],
  ["path", "Folder path"],
  ["on", "On"],
  ["next", "Play next instead of at the end"],
]);

/** `positionMs` → `Position ms`, for fields without a hand-written label. */
const humanize = (name: string): string => {
  const words = name.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();

  return words.charAt(0).toUpperCase() + words.slice(1);
};

const Representation = Schema.Struct({
  representation: Schema.Struct({
    id: Schema.String,
    payload: Schema.NullOr(Schema.Record(Schema.String, Schema.Finite)),
  }),
});

const decodeRepresentation = Schema.decodeUnknownOption(Representation);

/** The built-in checks on a node, as `effect/schema/isBetween`-style IDs and their payloads. */
const checksOf = (
  ast: SchemaAST.AST,
): ReadonlyArray<{
  readonly id: string;
  readonly payload: Readonly<Record<string, number>> | null;
}> =>
  (ast.checks ?? []).flatMap((check) =>
    Option.match(decodeRepresentation(check.annotations), {
      onNone: () => [],
      onSome: ({ representation }) => [representation],
    }),
  );

const numberField = (ast: SchemaAST.AST): FieldKind => {
  let integer = false;
  let min: number | null = null;
  let max: number | null = null;

  for (const check of checksOf(ast)) {
    if (check.id === "effect/schema/isInt") integer = true;

    min = check.payload?.["minimum"] ?? min;
    max = check.payload?.["maximum"] ?? max;
  }

  return { kind: "number", integer, min, max };
};

const fieldOf = (command: CommandName, name: string, ast: SchemaAST.AST): FieldKind | null => {
  const entity = entityOf(command, name);

  if (SchemaAST.isUnion(ast)) {
    const literals = ast.types.filter(SchemaAST.isLiteral).map((member) => String(member.literal));

    if (literals.length === ast.types.length) return { kind: "choice", options: literals };

    const inner = ast.types.find((member) => !SchemaAST.isNull(member));

    return inner === undefined ? null : fieldOf(command, name, inner);
  }

  if (SchemaAST.isArrays(ast)) return entity === undefined ? null : { kind: "ids", entity };

  if (SchemaAST.isString(ast)) {
    return entity === undefined ? { kind: "text", mono: name === "path" } : { kind: "id", entity };
  }

  if (SchemaAST.isNumber(ast)) return numberField(ast);

  if (SchemaAST.isBoolean(ast)) return { kind: "boolean" };

  return null;
};

/**
 * The editable arguments of a command, from its registry schema: strings, numbers, booleans,
 * literal unions, and ID pickers. Returns null when a field has a shape the form cannot edit, so
 * the command stays out of the menu instead of failing later.
 */
export const fieldsOf = (name: CommandName): ReadonlyArray<FieldSpec> | null => {
  const ast = commands[name].args.ast;

  if (!SchemaAST.isObjects(ast)) return null;

  const fields: Array<FieldSpec> = [];

  for (const property of ast.propertySignatures) {
    const key = String(property.name);
    const field = fieldOf(name, key, property.type);

    if (field === null) return null;

    fields.push({
      name: key,
      label: LABELS.get(key) ?? humanize(key),
      optional: SchemaAST.isOptional(property.type),
      field,
    });
  }

  return fields;
};

/** Form state: each field's raw value as typed or picked. */
export type FormValues = Readonly<
  Record<string, string | boolean | ReadonlyArray<string> | undefined>
>;

/**
 * Turns form values into wire arguments for the registry decoder: numbers parsed, empty optional
 * fields left out. The command's own schema then validates the result.
 */
export const rawArgs = (fields: ReadonlyArray<FieldSpec>, values: FormValues) =>
  Object.fromEntries(
    fields.flatMap((spec) => {
      const value = values[spec.name];

      if (value === undefined) return [];

      const numeric =
        spec.field.kind === "number" && !Array.isArray(value) && value !== true && value !== false;

      return [[spec.name, numeric ? Number(value) : value] as const];
    }),
  );

/**
 * The required fields that have no value yet: never set, blank text, or an empty selection. The
 * form names them instead of showing the schema decoder's message.
 */
export const missingFields = (
  fields: ReadonlyArray<FieldSpec>,
  values: FormValues,
): ReadonlyArray<FieldSpec> =>
  fields.filter((spec) => {
    if (spec.optional) return false;
    const value = values[spec.name];

    if (value === undefined) return true;

    if (value === true || value === false) return false;

    return Array.isArray(value) ? value.length === 0 : String(value).trim() === "";
  });
