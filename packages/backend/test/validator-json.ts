import { CONVEX_TABLE_ANNOTATION } from "@media/contracts/ids";
import { Match, Predicate, Schema, SchemaAST } from "effect";

/** Convex's JSON description of a validator. */
export type ValidatorJson =
  | { readonly type: "string" | "number" | "boolean" | "null" | "any" | "bigint" | "bytes" }
  | { readonly type: "id"; readonly tableName: string }
  | { readonly type: "literal"; readonly value: string | number | boolean }
  | { readonly type: "array"; readonly value: ValidatorJson }
  | { readonly type: "record"; readonly keys: ValidatorJson; readonly values: FieldJson }
  | { readonly type: "union"; readonly value: ReadonlyArray<ValidatorJson> }
  | { readonly type: "object"; readonly value: Readonly<Record<string, FieldJson>> };

interface FieldJson {
  readonly fieldType: ValidatorJson;
  readonly optional: boolean;
}

const Validator: Schema.Codec<ValidatorJson> = Schema.Union([
  Schema.Struct({
    type: Schema.Literals(["string", "number", "boolean", "null", "any", "bigint", "bytes"]),
  }),
  Schema.Struct({ type: Schema.Literal("id"), tableName: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("literal"),
    value: Schema.Union([Schema.String, Schema.Finite, Schema.Boolean]),
  }),
  Schema.Struct({ type: Schema.Literal("array"), value: Schema.suspend(() => Validator) }),
  Schema.Struct({
    type: Schema.Literal("record"),
    keys: Schema.suspend(() => Validator),
    values: Schema.suspend(() => Field),
  }),
  Schema.Struct({
    type: Schema.Literal("union"),
    value: Schema.Array(Schema.suspend(() => Validator)),
  }),
  Schema.Struct({
    type: Schema.Literal("object"),
    value: Schema.Record(
      Schema.String,
      Schema.suspend(() => Field),
    ),
  }),
]);

const Field: Schema.Codec<FieldJson> = Schema.Struct({
  fieldType: Schema.suspend(() => Validator),
  optional: Schema.Boolean,
});

/** Parses the JSON string `exportArgs()` or `exportReturns()` returns; `null` means no validator. */
export const parseExportedValidator = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.NullOr(Validator)),
);

const unsupported = (node: SchemaAST.AST): never => {
  throw new Error(`No Convex validator matches the schema ${String(node)}`);
};

/** Describes a schema's encoded side as Convex validator JSON. */
export const validatorFromSchema = (ast: SchemaAST.AST): ValidatorJson =>
  Match.valueTags(ast.encoding === undefined ? ast : SchemaAST.toEncoded(ast), {
    String: (node): ValidatorJson => {
      const table = SchemaAST.resolve(node)?.[CONVEX_TABLE_ANNOTATION];

      return Predicate.isString(table) ? { type: "id", tableName: table } : { type: "string" };
    },
    Number: (): ValidatorJson => ({ type: "number" }),
    Boolean: (): ValidatorJson => ({ type: "boolean" }),
    Null: (): ValidatorJson => ({ type: "null" }),
    Literal: (node): ValidatorJson =>
      Predicate.isBigInt(node.literal)
        ? unsupported(node)
        : { type: "literal", value: node.literal },
    Arrays: (node): ValidatorJson => {
      const [element] = node.rest;

      return node.elements.length > 0 || element === undefined || node.rest.length > 1
        ? unsupported(node)
        : { type: "array", value: validatorFromSchema(element) };
    },
    Objects: (node): ValidatorJson => {
      const [index] = node.indexSignatures;

      if (index !== undefined && node.propertySignatures.length === 0) {
        return {
          type: "record",
          keys: validatorFromSchema(index.parameter),
          values: { fieldType: validatorFromSchema(index.type), optional: false },
        };
      }

      return {
        type: "object",
        value: Object.fromEntries(
          node.propertySignatures.map((property) => [
            String(property.name),
            {
              fieldType: optionalFieldType(property.type),
              optional: SchemaAST.isOptional(property.type),
            },
          ]),
        ),
      };
    },
    Union: (node): ValidatorJson => ({ type: "union", value: node.types.map(validatorFromSchema) }),
    Suspend: (node): ValidatorJson => validatorFromSchema(node.thunk()),
    Any: unsupported,
    BigInt: unsupported,
    Declaration: unsupported,
    Enum: unsupported,
    Never: unsupported,
    ObjectKeyword: unsupported,
    Symbol: unsupported,
    TemplateLiteral: unsupported,
    Undefined: unsupported,
    UniqueSymbol: unsupported,
    Unknown: unsupported,
    Void: unsupported,
  });

/**
 * An optional field's validator. Convex drops fields set to `undefined` before they travel, so an
 * optional field that also allows `undefined` (`Schema.optional`) carries what `v.optional` does.
 */
const optionalFieldType = (node: SchemaAST.AST): ValidatorJson => {
  if (!SchemaAST.isOptional(node) || !SchemaAST.isUnion(node)) return validatorFromSchema(node);

  const [only, ...others] = node.types.filter((member) => !SchemaAST.isUndefined(member));

  if (only === undefined) return unsupported(node);

  return others.length === 0
    ? validatorFromSchema(only)
    : { type: "union", value: [only, ...others].map(validatorFromSchema) };
};

/** A canonical form: nested unions flattened, members sorted and deduplicated, keys sorted. */
export const normalizeValidator = (json: ValidatorJson): ValidatorJson => {
  if (json.type === "array") return { type: "array", value: normalizeValidator(json.value) };

  if (json.type === "record") {
    return {
      type: "record",
      keys: normalizeValidator(json.keys),
      values: { ...json.values, fieldType: normalizeValidator(json.values.fieldType) },
    };
  }

  if (json.type === "object") {
    return {
      type: "object",
      value: Object.fromEntries(
        Object.entries(json.value)
          .toSorted(([left], [right]) => left.localeCompare(right))
          .map(([key, field]) => [
            key,
            { ...field, fieldType: normalizeValidator(field.fieldType) },
          ]),
      ),
    };
  }

  if (json.type !== "union") return json;

  const members = json.value
    .map(normalizeValidator)
    .flatMap((member) => (member.type === "union" ? member.value : [member]));

  const unique = [...new Map(members.map((member) => [JSON.stringify(member), member])).entries()]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([, member]) => member);

  return unique.length === 1 && unique[0] !== undefined
    ? unique[0]
    : { type: "union", value: unique };
};
