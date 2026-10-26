/**
 * Talks to a real [music] Convex backend the way clients do: Convex Auth sign-in actions, the
 * typed command client from `@music/sdk`, and the media service functions with the shared secret.
 */
import type { CommandArgs, MutationName, QueryName } from "@music/commands/registry";
import { makeMusicClient, type MusicClient } from "@music/sdk/client";
import { commandFailure, type CommandFailure } from "@music/sdk/errors";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { expect } from "vitest";

/** Tokens Convex Auth returns from a successful sign-in. */
export interface Tokens {
  readonly token: string;
  readonly refreshToken: string;
}

type SignInParams =
  | { readonly provider: "password"; readonly params: Readonly<Record<string, string>> }
  | { readonly provider: "apikey"; readonly params: { readonly key: string } }
  | { readonly refreshToken: string };

const signInAction = makeFunctionReference<
  "action",
  SignInParams,
  { tokens?: Tokens | null | undefined }
>("auth:signIn");

const signOutAction = makeFunctionReference<"action", Record<string, never>, null>("auth:signOut");

/** One file the media service reports, with the tags the tests care about. */
export interface SeedTrack {
  readonly path: string;
  readonly title: string;
  readonly artist: string;
  readonly album: string;
  readonly artHash: string;
}

const upsertTracksMutation = makeFunctionReference<
  "mutation",
  {
    secret: string;
    libraryId: string;
    tracks: ReadonlyArray<{
      path: string;
      size: number;
      mtimeMs: number;
      title: string;
      artist: string;
      album: string;
      durationMs: number;
      codec: string;
      lossless: boolean;
      artHash: string;
      lyricsFiles: string;
      lyricsReader: number;
      lyrics: ReadonlyArray<never>;
    }>;
  },
  { upserted: number }
>("media:upsertTracks");

const librariesQuery = makeFunctionReference<
  "query",
  { secret: string },
  ReadonlyArray<{ id: string; path: string }>
>("media:libraries");

const claimRootMutation = makeFunctionReference<
  "mutation",
  {
    secret: string;
    libraryId: string;
    realPath: string;
    rootIds: ReadonlyArray<string>;
    fsPath: string | null;
    bootId: string | null;
  },
  { ok: true } | { ok: false; error: string }
>("media:claimRoot");

/** A Convex connection, optionally signed in, with the typed command client on top. */
export interface Session {
  readonly convex: ConvexHttpClient;
  readonly music: MusicClient;
  readonly tokens: Tokens | null;
}

/** Opens a connection without credentials. */
export const anonymous = (url: string): Session => {
  const convex = new ConvexHttpClient(url, { logger: false });

  return { convex, music: makeMusicClient(convex), tokens: null };
};

/** Opens a connection that sends `tokens` (or nothing, for `null`). */
export const withTokens = (url: string, tokens: Tokens | null): Session => {
  const session = anonymous(url);

  if (tokens !== null) session.convex.setAuth(tokens.token);

  return { ...session, tokens };
};

/** Runs the sign-in action and returns its tokens, or null when the server signs nobody in. */
export const signIn = async (url: string, params: SignInParams): Promise<Tokens | null> => {
  const result = await anonymous(url).convex.action(signInAction, params);

  return result.tokens ?? null;
};

/** Signs out the session behind `tokens`. */
export const signOut = async (url: string, tokens: Tokens): Promise<void> => {
  await withTokens(url, tokens).convex.action(signOutAction, {});
};

/** Password sign-up; resolves the session or rejects with the server's error. */
export const signUp = async (
  url: string,
  account: { readonly email: string; readonly password: string; readonly inviteCode?: string },
): Promise<Session> => {
  const tokens = await signIn(url, {
    provider: "password",
    params: { flow: "signUp", name: account.email.split("@")[0] ?? "user", ...account },
  });

  if (tokens === null) throw new Error(`Sign-up returned no tokens for ${account.email}`);

  return withTokens(url, tokens);
};

/** Password sign-in; resolves the session or rejects with the server's error. */
export const passwordSignIn = async (
  url: string,
  email: string,
  password: string,
): Promise<Session> => {
  const tokens = await signIn(url, {
    provider: "password",
    params: { flow: "signIn", email, password },
  });

  if (tokens === null) throw new Error(`Sign-in returned no tokens for ${email}`);

  return withTokens(url, tokens);
};

/** Redeems a password reset token with a new password; resolves the new session. */
export const resetPassword = async (
  url: string,
  token: string,
  newPassword: string,
): Promise<Session> => {
  const tokens = await signIn(url, {
    provider: "password",
    params: { flow: "reset", token, newPassword },
  });

  if (tokens === null) throw new Error("The password reset returned no tokens");

  return withTokens(url, tokens);
};

/**
 * Claims a library's folder as the media service does before a scan: at the path it was added
 * with, under a made-up identity no other library shares.
 */
const claimFolder = async (url: string, secret: string, libraryId: string) => {
  const { convex } = anonymous(url);
  const libraries = await convex.query(librariesQuery, { secret });
  const library = libraries.find((candidate) => candidate.id === libraryId);

  if (library === undefined) throw new Error(`${libraryId} is not a library`);

  const claim = await convex.mutation(claimRootMutation, {
    secret,
    libraryId,
    realPath: library.path,
    rootIds: [`test:${libraryId}`],
    fsPath: null,
    bootId: null,
  });

  if (!claim.ok) throw new Error(`The claim on ${library.path} was refused: ${claim.error}`);
};

/** Upserts tracks into a library as the media service does, claiming its folder first. */
export const upsertTracks = async (
  url: string,
  secret: string,
  libraryId: string,
  tracks: ReadonlyArray<SeedTrack>,
): Promise<void> => {
  await claimFolder(url, secret, libraryId);

  await anonymous(url).convex.mutation(upsertTracksMutation, {
    secret,
    libraryId,
    tracks: tracks.map((track, index) => ({
      ...track,
      size: 1000 + index,
      mtimeMs: 1_700_000_000_000,
      durationMs: 180_000,
      codec: "flac",
      lossless: true,
      lyricsFiles: "",
      lyricsReader: 0,
      lyrics: [],
    })),
  });
};

/** The expected-failure code a rejected call carried, or a description of what happened instead. */
export const failureCode = async (call: Promise<unknown>): Promise<string> => {
  try {
    await call;

    return "succeeded";
  } catch (error) {
    if (!(error instanceof Error)) return "threw a non-error";

    return commandFailure(error)?.code ?? `failed without a code: ${error.message}`;
  }
};

/** The expected failure a rejected call carried, or a description of what happened instead. */
export const failure = async (call: Promise<unknown>): Promise<CommandFailure | string> => {
  try {
    await call;

    return "succeeded";
  } catch (error) {
    if (!(error instanceof Error)) return "threw a non-error";

    return commandFailure(error) ?? `failed without a code: ${error.message}`;
  }
};

/** Asserts that a query command fails with `code`. */
export const expectReadFailure = async <Name extends QueryName>(
  session: Session,
  name: Name,
  args: CommandArgs<Name>,
  code: string,
): Promise<void> => {
  expect(await failureCode(session.music.read(name, args)), `${name} should fail`).toBe(code);
};

/** Asserts that a mutation command fails with `code`. */
export const expectRunFailure = async <Name extends MutationName>(
  session: Session,
  name: Name,
  args: CommandArgs<Name>,
  code: string,
): Promise<void> => {
  expect(await failureCode(session.music.run(name, args)), `${name} should fail`).toBe(code);
};

/** A short random suffix, so the suite can run again against the same server. */
export const runId = (): string => Math.random().toString(36).slice(2, 8);
