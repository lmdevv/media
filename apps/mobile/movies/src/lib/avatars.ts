/**
 * The letter on a person's avatar: the name's first character, uppercased. Characters outside the
 * Basic Multilingual Plane, such as emoji, stay whole rather than splitting into half a pair.
 */
export const monogram = (name: string): string => {
  const first = name.trim().codePointAt(0);

  return first === undefined ? "" : String.fromCodePoint(first).toUpperCase();
};
