import packageJson from "../package.json" with { type: "json" };

/**
 * The version of Lar this server runs, read from its package. It is reported as text, not decoded,
 * so no version keeps the server from starting; `scripts/check-version.sh` makes every released one
 * a `Release` the apps can compare.
 */
export const RELEASE: string = packageJson.version;
