import { artworkTicketId, TICKET_PARAM } from "@media/contracts/ticket";
import type { Value } from "convex/values";

import { issueShareableTicket } from "../core/tickets";

const ARTWORK_FIELDS: ReadonlySet<string> = new Set([
  "poster",
  "backdrop",
  "logo",
  "still",
  "profile",
]);

/**
 * An artwork key as the server mints it: the pattern of `ArtworkKey` in `@media/contracts/artwork`,
 * repeated so no Effect Schema runs in a Convex function. A field named like artwork holds
 * something else in one place, a video or audio stream's codec `profile`, which never has this
 * shape.
 */
const ARTWORK_KEY = /^a1\.[\w-]+$/u;

/** The artwork path of each key one result names, so a key repeated in it is signed once. */
type Paths = Map<string, Promise<string>>;

const pathOf = async (key: string): Promise<string> => {
  const { ticket } = await issueShareableTicket({
    kind: "artwork",
    id: await artworkTicketId(key),
  });

  return `/artwork/${encodeURIComponent(key)}?${TICKET_PARAM}=${ticket}`;
};

const memoizedPath = (paths: Paths, key: string): Promise<string> => {
  const known = paths.get(key);

  if (known !== undefined) return known;

  const path = pathOf(key);

  paths.set(key, path);

  return path;
};

/** A plain object a Convex value holds: a document or a result's object, by field. */
type Fields = { readonly [field: string]: Value | undefined };

// SAFETY: a type predicate, not checked by the compiler. A Convex value is null, a boolean, a
// number, a bigint, a string, an ArrayBuffer, an array, or a plain object, and only a plain object
// has `Object.prototype` as its prototype.
const isFields = (value: Value): value is Fields =>
  value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

// SAFETY: a type predicate, not checked by the compiler. Of the kinds of Convex value, only a
// string has `String.prototype` as its prototype.
const isText = (value: Value): value is string =>
  value !== null && Object.getPrototypeOf(value) === String.prototype;

const withPaths = async (value: Value, paths: Paths): Promise<Value> => {
  if (Array.isArray(value)) return Promise.all(value.map(async (item) => withPaths(item, paths)));

  if (!isFields(value)) return value;

  const fields = await Promise.all(
    Object.entries(value).map(async ([field, inner]) => {
      if (inner === undefined) return [field, inner] as const;

      return isText(inner) && ARTWORK_FIELDS.has(field) && ARTWORK_KEY.test(inner)
        ? ([field, await memoizedPath(paths, inner)] as const)
        : ([field, await withPaths(inner, paths)] as const);
    }),
  );

  return Object.fromEntries(fields);
};

type Handler = (ctx: never, args: never, caller: never) => Value | Promise<Value>;

type Wrapped = Readonly<Record<string, Handler>>;

// SAFETY: a type predicate, not checked by the compiler past the names. `wrapped` holds, under
// each name of `handlers`, a function that takes that handler's arguments and answers its result
// with only artwork keys replaced by paths, both strings, so it has that handler's type. Convex
// checks each result against the command's `returns` validator again.
const keepsHandlers = <Handlers extends { readonly [Name in keyof Handlers]: Handler }>(
  handlers: Handlers,
  wrapped: Wrapped,
): wrapped is Handlers & Wrapped =>
  Object.keys(handlers).every((name) => Object.hasOwn(wrapped, name));

/**
 * Registers the handlers of one movies command file through its generated `register`, with every
 * artwork key their results name replaced by the artwork's path with its shareable `image` ticket
 * (ADR 0011): `/artwork/<key>?ticket=<ticket>`, which a client prefixes with the media server's
 * address and may follow with `&w=<width>`. So every client-facing result carries tickets, and
 * stored rows and server functions keep bare keys. A field is artwork by its name, `poster`,
 * `backdrop`, `logo`, `still`, or a person's `profile`, at any depth, holding a key; null stays
 * null. Tickets for one artwork are the same string for a week, so a query may issue them, and one
 * result signs each key it names once.
 *
 * @throws Error at module load when a wrapped handler went missing, which only a defect gives.
 */
export const registerWithArtworkTickets = <
  Handlers extends { readonly [Name in keyof Handlers]: Handler },
  Registered,
>(
  register: (handlers: Handlers) => Registered,
  handlers: Handlers,
): Registered => {
  const wrapped = Object.fromEntries(
    Object.entries<Handler>(handlers).map(([name, handler]) => [
      name,
      async (...args: Parameters<Handler>) => withPaths(await handler(...args), new Map()),
    ]),
  );

  if (!keepsHandlers(handlers, wrapped)) throw new Error("The movies handlers lost their types");

  return register(wrapped);
};
