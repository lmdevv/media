import { readdirSync } from "node:fs";

/** One segment of a route file's path, once per group of an array group such as `(home,library)`. */
const variants = (segment: string): ReadonlyArray<string> => {
  const groups = /^\((.+,.+)\)$/u.exec(segment)?.[1];

  return groups === undefined ? [segment] : groups.split(",").map((group) => `(${group.trim()})`);
};

/**
 * The route patterns Expo Router's `useSegments` can name for the app whose route files live under
 * `root` (its `src/app`): one per route file, a file under an array group once per group, an index
 * route by its folder, and the not-found and sitemap screens Expo Router adds; layouts and `+` files
 * are not routes. Sorted.
 */
export const routePatternsUnder = (root: string): ReadonlyArray<string> => {
  const files = readdirSync(root, { recursive: true, encoding: "utf8" }).filter((path) =>
    /\.tsx?$/u.test(path),
  );

  const patterns = files.flatMap((file) => {
    const segments = file.replace(/\.tsx?$/u, "").split("/");
    const last = segments.at(-1) ?? "";

    if (last === "_layout" || last.startsWith("+")) return [];

    const path = last === "index" ? segments.slice(0, -1) : segments;

    return path
      .reduce<ReadonlyArray<ReadonlyArray<string>>>(
        (prefixes, segment) =>
          prefixes.flatMap((prefix) => variants(segment).map((each) => prefix.concat(each))),
        [[]],
      )
      .map((each) => `/${each.join("/")}`);
  });

  return [...new Set(["/+not-found", "/_sitemap", ...patterns])].toSorted();
};
