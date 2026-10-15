/**
 * Convex Auth sign-in in the in-memory backend: the real `auth:signIn` action with the password
 * provider, signing tokens with a key made for the test run.
 */
import type { InviteId, UserId } from "@music/commands/ids";
import { makeMusicClient } from "@music/sdk/client";
import { decodeJwt, exportJWK, exportPKCS8, generateKeyPair } from "jose";

import { api } from "../convex/_generated/api";
import type { Backend, User } from "./backend";

/** Gives Convex Auth a signing key and site URL; once per test file is enough. */
export const enableAuth = async (): Promise<void> => {
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });

  process.env["JWT_PRIVATE_KEY"] = (await exportPKCS8(privateKey)).replaceAll("\n", " ");
  process.env["JWKS"] = JSON.stringify({ keys: [{ use: "sig", ...(await exportJWK(publicKey)) }] });
  process.env["CONVEX_SITE_URL"] = "http://127.0.0.1:1";
};

/** The password provider's flows, as clients send them. */
export type PasswordParams =
  | { readonly flow: "signIn"; readonly email: string; readonly password: string }
  | {
      readonly flow: "signUp";
      readonly email: string;
      readonly password: string;
      readonly name?: string;
      readonly inviteCode?: string;
    }
  | { readonly flow: "reset"; readonly token: string; readonly newPassword: string };

/** Runs a password sign-in flow; resolves the signed-in user or rejects with the server's error. */
export const passwordFlow = async (backend: Backend, params: PasswordParams): Promise<User> => {
  const result = await backend.action(api.auth.signIn, { provider: "password", params });
  const token = result.tokens?.token;

  if (token === undefined) throw new Error("The sign-in returned no tokens");
  // The token's subject is `<userId>|<sessionId>`, as `loadViewer` reads it.
  const subject = decodeJwt(token).sub ?? "";
  const signedIn = backend.withIdentity({ subject });
  const [userId = ""] = subject.split("|");
  const id = await backend.run(async (ctx) => ctx.db.normalizeId("users", userId));

  if (id === null) throw new Error(`The token's subject ${subject} names no user`);

  return {
    id,
    as: signedIn,
    music: makeMusicClient({
      query: (reference, args) => signedIn.query(reference, args),
      mutation: (reference, args) => signedIn.mutation(reference, args),
    }),
  };
};

/** Invites someone as `role` and signs them up with a password through Convex Auth. */
export const joinWithPassword = async (
  backend: Backend,
  inviter: User,
  account: {
    readonly email: string;
    readonly password: string;
    readonly role: "admin" | "member" | "guest";
  },
): Promise<User & { readonly userId: UserId; readonly inviteId: InviteId }> => {
  const invite = await inviter.music.run("invites.create", { role: account.role });

  const user = await passwordFlow(backend, {
    flow: "signUp",
    email: account.email,
    password: account.password,
    inviteCode: invite.code,
  });

  const me = await user.music.read("account.me", {});

  return { ...user, userId: me.id, inviteId: invite.id };
};
