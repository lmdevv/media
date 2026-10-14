/** A loopback host: the CLI sends the key to it over plain http:// without asking. */
const isLoopbackHost = (host: string): boolean =>
  host === "localhost" ||
  host.endsWith(".localhost") ||
  host === "[::1]" ||
  /^127(?:\.\d{1,3}){3}$/u.test(host);

/**
 * Whether the CLI refuses `server` without `--insecure` (or `MUSIC_INSECURE=1`): a plain http://
 * URL to another machine would send the API key unencrypted. Mirrors `sendsKeyInCleartext` in
 * `apps/cli/src/config.ts`.
 */
export const needsInsecure = (server: string): boolean => {
  if (!URL.canParse(server)) return false;

  const url = new URL(server);

  return url.protocol === "http:" && !isLoopbackHost(url.hostname);
};

/** `value` as one shell word: single-quoted, with any single quote in it escaped. */
const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

/** `music login --server <server>`, quoted for a shell, with `--insecure` where the CLI needs it. */
export const cliLoginBase = (server: string): string =>
  `music login --server ${shellQuote(server)}${needsInsecure(server) ? " --insecure" : ""}`;

/** The `music login` command Settings → Keys suggests for this server, piping the key in. */
export const cliLoginCommand = (server: string): string =>
  `printf '%s' "$KEY" | ${cliLoginBase(server)} --key-stdin`;
