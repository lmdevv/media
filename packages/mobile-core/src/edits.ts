/**
 * Edits to a live row, as the owner forms of every [media] iOS app save them. A row on screen
 * keeps following the core while someone edits it, so a form never compares what the person
 * typed with the live row: another admin's change would read as the person's own, and saving
 * would write it back over them. Each field instead remembers the value it had when the person
 * began editing it. A save writes only fields the person changed from that value, and asks first
 * when such a field changed on the core meanwhile.
 */

/** A value a form field holds: text, a number, a choice, or a list of them. */
export type FieldValue = string | number | boolean | null | ReadonlyArray<FieldValue>;

const isList = (value: FieldValue): value is ReadonlyArray<FieldValue> => Array.isArray(value);

/** Whether two field values are the same, lists element by element. */
export const sameValue = (left: FieldValue, right: FieldValue): boolean => {
  if (isList(left) && isList(right)) {
    return (
      left.length === right.length &&
      left.every((each, at) => {
        const other = right[at];

        return other !== undefined && sameValue(each, other);
      })
    );
  }

  return left === right;
};

/** One field of a form: untouched, or edited from the value it had when editing began. */
export type FieldEdit<V extends FieldValue> =
  | { readonly kind: "unedited" }
  | {
      readonly kind: "edited";
      /** What the person saves. */
      readonly to: V;
      /** The field changed on the core since the person began editing it. */
      readonly overtaken: boolean;
    };

/**
 * A field as a save sees it. `from` is its value when the person began editing it, `to` the
 * value they leave in the form, and `live` its value on the core now. A field the person put
 * back as it was counts as unedited, even if the core changed it meanwhile.
 */
export const fieldEdit = <V extends FieldValue>(from: V, to: V, live: V): FieldEdit<V> =>
  sameValue(from, to)
    ? { kind: "unedited" }
    : { kind: "edited", to, overtaken: !sameValue(live, from) };

/** The fields a save would write over a change made on the core meanwhile, by their names. */
export const overtakenFields = (
  fields: Readonly<Record<string, FieldEdit<FieldValue>>>,
): ReadonlyArray<string> =>
  Object.entries(fields).flatMap(([name, edit]) =>
    edit.kind === "edited" && edit.overtaken ? [name] : [],
  );

/** Whether a save of `fields` has anything to write. */
export const anyEdited = (fields: ReadonlyArray<FieldEdit<FieldValue>>): boolean =>
  fields.some((edit) => edit.kind === "edited");

/** `Name and Folders changed while you were editing.`: the question a form asks before saving. */
export const overtakenLine = (names: ReadonlyArray<string>): string => {
  const listed =
    names.length <= 1
      ? (names[0] ?? "This")
      : `${names.slice(0, -1).join(", ")} and ${names.at(-1) ?? ""}`;

  return `${listed} changed while you were editing.`;
};
