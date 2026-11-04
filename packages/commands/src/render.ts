import { Match, Predicate } from "effect";

import type { Wire, WireField } from "./check.ts";

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/u;

const key = (name: string): string => (IDENTIFIER.test(name) ? name : JSON.stringify(name));

const literalSource = (value: string | number | boolean | bigint): string =>
  Predicate.isBigInt(value) ? `${value}n` : Object.is(value, -0) ? "-0" : JSON.stringify(value);

/** The fields of an object validator as source, such as `{ name: v.string() }`. */
export const fieldsSource = (fields: ReadonlyArray<WireField>): string =>
  `{ ${fields
    .map(
      (field) =>
        `${key(field.name)}: ${field.optional ? `v.optional(${wireSource(field.wire)})` : wireSource(field.wire)}`,
    )
    .join(", ")} }`;

/** A value's Convex validator as source, such as `v.array(v.string())`. */
export const wireSource = (wire: Wire): string =>
  Match.value(wire).pipe(
    Match.discriminatorsExhaustive("kind")({
      string: () => "v.string()",
      float64: () => "v.number()",
      int64: () => "v.int64()",
      boolean: () => "v.boolean()",
      null: () => "v.null()",
      bytes: () => "v.bytes()",
      id: (id) => `v.id(${JSON.stringify(id.table)})`,
      literal: (literal) => `v.literal(${literalSource(literal.value)})`,
      array: (array) => `v.array(${wireSource(array.element)})`,
      record: (record) => `v.record(${wireSource(record.key)}, ${wireSource(record.value)})`,
      union: (union) => `v.union(${union.members.map(wireSource).join(", ")})`,
      object: (object) => `v.object(${fieldsSource(object.fields)})`,
    }),
  );

/**
 * The fields of an object as an Effect Schema struct, such as `Schema.Struct({ name:
 * Schema.String })`. An optional field is an absent key, as Convex drops `undefined`.
 */
export const fieldsSchema = (fields: ReadonlyArray<WireField>): string =>
  `Schema.Struct({ ${fields
    .map(
      (field) =>
        `${key(field.name)}: ${field.optional ? `Schema.optionalKey(${wireSchema(field.wire)})` : wireSchema(field.wire)}`,
    )
    .join(", ")} })`;

/**
 * A value's Effect Schema as source, whose encoded side is the value Convex sends, such as
 * `Schema.Array(Schema.String)`. An ID is a string branded with its table, `Id<users>`, so an ID
 * from one result type-checks only where the same table's ID is expected.
 */
export const wireSchema = (wire: Wire): string =>
  Match.value(wire).pipe(
    Match.discriminatorsExhaustive("kind")({
      string: () => "Schema.String",
      float64: () => "Schema.Finite",
      int64: () => "Schema.BigInt",
      boolean: () => "Schema.Boolean",
      null: () => "Schema.Null",
      bytes: () => "Schema.instanceOf(ArrayBuffer)",
      id: (id) => `Schema.String.pipe(Schema.brand(${JSON.stringify(`Id<${id.table}>`)}))`,
      literal: (literal) => `Schema.Literal(${literalSource(literal.value)})`,
      array: (array) => `Schema.Array(${wireSchema(array.element)})`,
      record: (record) => `Schema.Record(${wireSchema(record.key)}, ${wireSchema(record.value)})`,
      union: (union) => `Schema.Union([${union.members.map(wireSchema).join(", ")}])`,
      object: (object) => fieldsSchema(object.fields),
    }),
  );

/** The fields of an object as a TypeScript type, such as `{ name: string; year?: number }`. */
export const fieldsType = (fields: ReadonlyArray<WireField>): string =>
  fields.length === 0
    ? "{}"
    : `{ ${fields
        .map((field) => `${key(field.name)}${field.optional ? "?" : ""}: ${wireType(field.wire)}`)
        .join("; ")} }`;

/** A value as a TypeScript type, such as `Array<string>`, for references people and agents read. */
export const wireType = (wire: Wire): string =>
  Match.value(wire).pipe(
    Match.discriminatorsExhaustive("kind")({
      string: () => "string",
      float64: () => "number",
      int64: () => "bigint",
      boolean: () => "boolean",
      null: () => "null",
      bytes: () => "ArrayBuffer",
      id: (id) => `Id<${JSON.stringify(id.table)}>`,
      literal: (literal) => literalSource(literal.value),
      array: (array) => `Array<${wireType(array.element)}>`,
      record: (record) => `Record<${wireType(record.key)}, ${wireType(record.value)}>`,
      union: (union) => union.members.map(wireType).join(" | "),
      object: (object) => fieldsType(object.fields),
    }),
  );
