/**
 * URL search serialization for the router. Every value stays a plain string so each route parses
 * its own with a schema. The router's built-in decoder turns `"2020"` into a number and `"true"`
 * into a boolean before any custom parser runs, which made routes with string schemas fail on a
 * search for a year or on `?add=1`.
 */

/** Reads a query string (with or without the leading `?`) into string values. */
export const parseSearch = (search: string): Record<string, string> =>
  Object.fromEntries(new URLSearchParams(search));

/**
 * Writes search values back into a query string with the leading `?`, or `""` when empty.
 * Every route's search schema holds optional strings; missing values are left out.
 */
export const stringifySearch = (search: Readonly<Record<string, string | undefined>>): string => {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(search)) {
    if (value !== undefined) params.set(key, value);
  }

  const query = params.toString();

  return query === "" ? "" : `?${query}`;
};
