/**
 * URL search serialization for the router. Every value stays a plain string so each route parses
 * its own. The router's default decoder turns `"2020"` into a number before a route sees it, which
 * breaks a search for a year.
 */

/** Reads a query string (with or without the leading `?`) into string values. */
export const parseSearch = (search: string): Record<string, string> =>
  Object.fromEntries(new URLSearchParams(search));

/**
 * Writes search values back into a query string with the leading `?`, or `""` when empty. Every
 * route's search holds optional strings; missing and empty values are left out.
 */
export const stringifySearch = (search: Readonly<Record<string, string | undefined>>): string => {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(search)) {
    if (value !== undefined && value !== "") params.set(key, value);
  }

  const query = params.toString();

  return query === "" ? "" : `?${query}`;
};
