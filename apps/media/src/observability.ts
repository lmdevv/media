/**
 * Structured JSON logs on standard output and in the retained log files (`logging/retained-logs.ts`),
 * at `LOG_LEVEL` and above, plus OTLP traces and logs when `OTEL_EXPORTER_OTLP_ENDPOINT` is set.
 * Nothing here should ever see a token or secret: request logs carry paths without query strings,
 * tool errors scrub absolute paths, and configuration secrets stay `Redacted`. As a last line of
 * defense every log line and every OTLP export is redacted on the way out: fields named like
 * credentials, and values shaped like tokens, API keys, admin keys, credential query parameters,
 * and invite codes in invite links. Exports matter as much as logs: HTTP spans record `url.full`
 * and `url.query`, which carry playback tokens.
 */
import { Effect, Formatter, Layer, Logger, Option, Predicate, References, Schema } from "effect";
import { FetchHttpClient, HttpBody } from "effect/http";
import { OtlpLogger, OtlpSerialization, OtlpTracer } from "effect/observability";

import * as RetainedLogs from "./logging/retained-logs.ts";
import * as MediaConfig from "./media-config.ts";

const resource = { serviceName: "movies-media" };

const REDACTED = "<redacted>";

const SECRET_FIELD =
  /(?:token|ticket|secret|password|passwd|api[-_]?key|authorization|cookie|credentials?)$/i;

const URL_FIELDS: ReadonlySet<string> = new Set([
  "http.url",
  "http.target",
  "url.full",
  "url.path",
  "url.original",
  "route",
]);

const QUERY_FIELD = "url.query";

const URL_IN_TEXT = /\b[a-z][a-z\d+.-]*:\/\/[^\s"'<>]+/gi;

const REQUEST_LINE = /\b(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS) (\/[^\s"'<>]*)/g;

const URL_PARTS = /^([a-z][a-z\d+.-]*:\/\/[^/?#]*)?([^?#]*)(?:\?([^#]*))?(#.*)?$/is;

const MAY_HOLD_INVITE = /invite|%|\\/i;

const PATH_SEPARATOR = /[/\\]/;

const decodeComponent = Option.liftThrowable(decodeURIComponent);

const isInvite = (segment: string | undefined): boolean => segment?.toLowerCase() === "invite";

/**
 * `path` with the segment after any `invite` segment redacted, as the web app routes
 * `/invite/<code>` in any case and with repeated, encoded, or backward slashes, which URL parsing
 * reads as slashes. A redacted path comes back decoded and with its slashes collapsed; any other
 * path comes back unchanged.
 */
const redactInvitePath = (path: string): string => {
  const decoded = Option.getOrElse(decodeComponent(path), () => path);
  const segments = decoded.split(PATH_SEPARATOR).filter((segment) => segment.length > 0);

  if (!segments.some((_, index) => index > 0 && isInvite(segments[index - 1]))) return path;

  const redacted = segments.map((segment, index) =>
    index > 0 && isInvite(segments[index - 1]) ? REDACTED : segment,
  );

  return `${PATH_SEPARATOR.test(decoded.charAt(0)) ? "/" : ""}${redacted.join("/")}`;
};

const redactInviteQuery = (query: string): string => {
  if (!MAY_HOLD_INVITE.test(query)) return query;
  const params = [...new URLSearchParams(query)];
  const redacted = params.map(([name, value]): [string, string] => [name, redactInviteUrl(value)]);

  return redacted.every(([, value], index) => value === params[index]?.[1])
    ? query
    : new URLSearchParams(redacted).toString();
};

const redactInviteUrl = (url: string): string => {
  if (!MAY_HOLD_INVITE.test(url)) return url;
  const [, origin = "", path = "", query, fragment = ""] = URL_PARTS.exec(url) ?? [];

  return `${origin}${redactInvitePath(path)}${query === undefined ? "" : `?${redactInviteQuery(query)}`}${fragment}`;
};

const SECRET_VALUES: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /\b((?:access_|x-plex-|x-emby-)?token|ticket|api_?key|key|secret|password)=[^\s&"',;\\]+/gi,
    `$1=${REDACTED}`,
  ],
  [
    /(["']?)\b([\w.-]*?(?:token|secret|password|passwd|api[-_]?key|authorization|cookie|credentials?))\1(\s*[:=]\s*)(["'])(?:\\.|(?!\4)[^\\])*\4/gi,
    `$1$2$1$3$4${REDACTED}$4`,
  ],
  [/\b(Bearer|Basic)\s+[\w.~+/=-]+/gi, `$1 ${REDACTED}`],
  [/\bToken="[^"]*"/g, `Token="${REDACTED}"`],
  [/\beyJ[\w-]+\.[\w-]+(?:\.[\w-]+)?/g, REDACTED],
  [/\bmk_[\w-]{16,}/g, REDACTED],
  // A core ticket (ADR 0011): `t1.<kid>.<aud>.<iat>.<exp>.` and the rest up to its MAC.
  [/\bt1\.[a-z0-9]{1,16}\.[a-z0-9]+\.\d+\.\d+\.[\w.-]+/g, REDACTED],
  [/\b[\w-]+\|[0-9a-f]{32,}\b/g, REDACTED],
];

/**
 * `text` with every token-shaped value replaced, as every log line and export is redacted. In free
 * text only absolute URLs and request lines such as `GET /invite/…` (HTTP server errors describe
 * their request that way) lose invite codes; `redactJson` redacts URL-valued fields as URLs.
 */
export const redactText = (text: string): string =>
  SECRET_VALUES.reduce(
    (redacted, [pattern, replacement]) => redacted.replace(pattern, replacement),
    text
      .replace(URL_IN_TEXT, redactInviteUrl)
      .replace(
        REQUEST_LINE,
        (_, method: string, url: string) => `${method} ${redactInviteUrl(url)}`,
      ),
  );

const isUrlField = (key: string): boolean => key === QUERY_FIELD || URL_FIELDS.has(key);

const redactUrlField = (key: string, value: string): string =>
  redactText(key === QUERY_FIELD ? redactInviteQuery(value) : redactInviteUrl(value));

const isJsonArray = (value: Schema.JsonArray | Schema.JsonObject): value is Schema.JsonArray =>
  Array.isArray(value);

const decodeJson = Schema.decodeOption(Schema.fromJsonString(Schema.Json));

const isStringValue = Schema.is(Schema.Struct({ stringValue: Schema.String }));

/**
 * `value` with credential fields and token-shaped strings replaced, at any depth, including JSON
 * serialized into a string (OTLP flattens objects and log messages that way). OTLP attributes are
 * `{ key, value }` pairs, so a pair whose `key` names a credential loses its value too.
 */
const redactJson = (value: Schema.Json): Schema.Json => {
  if (Predicate.isString(value)) return redactString(value);

  if (value === null || Predicate.isNumber(value) || Predicate.isBoolean(value)) return value;

  if (isJsonArray(value)) return value.map(redactJson);

  const attributeKey = value["key"];
  const secretAttribute = Predicate.isString(attributeKey) && SECRET_FIELD.test(attributeKey);
  const urlAttribute = Predicate.isString(attributeKey) && isUrlField(attributeKey);

  return Object.fromEntries(
    Object.entries(value).map(([key, field]): [string, Schema.Json] => {
      if (secretAttribute && key === "value") return [key, { stringValue: REDACTED }];

      if (urlAttribute && key === "value" && isStringValue(field)) {
        return [key, { stringValue: redactUrlField(attributeKey, field.stringValue) }];
      }

      if (isUrlField(key) && Predicate.isString(field)) return [key, redactUrlField(key, field)];

      return [key, SECRET_FIELD.test(key) ? REDACTED : redactJson(field)];
    }),
  );
};

/** JSON `text` redacted field by field; text that is not JSON is redacted as a whole. */
export const redactJsonText = (text: string): string =>
  Option.match(decodeJson(text), {
    onNone: () => redactText(text),
    onSome: (json) => JSON.stringify(redactJson(json)),
  });

const redactString = (text: string): string =>
  /^\s*[[{]/.test(text) ? redactJsonText(text) : redactText(text);

/** The JSON line of a log record, redacted, as the console and the retained log receive it. */
export const redactedLine = Logger.map(Logger.formatStructured, (structured) =>
  redactJsonText(Formatter.formatJson(structured)),
);

const teeLogger = (retained: RetainedLogs.Interface) =>
  Logger.withConsoleLog(
    Logger.make((options) => {
      const line = redactedLine.log(options);

      retained.append(line, options.date.getTime());

      return line;
    }),
  );

const redactedSerialization = Layer.succeed(OtlpSerialization.OtlpSerialization, {
  traces: (data) => HttpBody.text(redactJsonText(JSON.stringify(data)), "application/json"),
  metrics: (data) => HttpBody.text(redactJsonText(JSON.stringify(data)), "application/json"),
  logs: (data) => HttpBody.text(redactJsonText(JSON.stringify(data)), "application/json"),
});

/**
 * Logging, the retained log (whose `RetainedLogs` service the log routes read), and optional
 * telemetry export; provide it to the whole application.
 */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* MediaConfig.Service;
    const retained = yield* RetainedLogs.Service;

    const logs = Layer.mergeAll(
      Logger.layer([teeLogger(retained)]),
      Layer.succeed(References.MinimumLogLevel, config.logs.level),
      Layer.succeed(RetainedLogs.Service, retained),
    );

    if (Option.isNone(config.otlpEndpoint)) return logs;
    const endpoint = config.otlpEndpoint.value;

    const telemetry = Layer.mergeAll(
      OtlpTracer.layer({ url: `${endpoint}/v1/traces`, resource }),
      OtlpLogger.layer({ url: `${endpoint}/v1/logs`, resource }),
    ).pipe(Layer.provide(redactedSerialization), Layer.provide(FetchHttpClient.layer));

    // The OTLP logger keeps only the loggers present when it is built, so it is built after them.
    return Layer.provideMerge(telemetry, logs);
  }),
).pipe(Layer.provide(RetainedLogs.layer));
