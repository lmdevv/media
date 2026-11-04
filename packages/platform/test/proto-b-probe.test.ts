import { existsSync, readFileSync } from "node:fs";

import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { describe, expect, it } from "vitest";

const envOf = (path: string): ReadonlyMap<string, string> =>
  new Map(
    existsSync(path)
      ? readFileSync(path, "utf8")
          .split("\n")
          .flatMap((line) => {
            const at = line.indexOf("=");

            return at > 0 ? [[line.slice(0, at), line.slice(at + 1)] as const] : [];
          })
      : [],
  );

const coreUrl = envOf(new URL("../.env.local", import.meta.url).pathname).get(
  "CONVEX_SELF_HOSTED_URL",
);

const moviesUrl = envOf(new URL("../../backend/.env.local", import.meta.url).pathname).get(
  "CONVEX_SELF_HOSTED_URL",
);

const live = process.env["MEDIA_STACK_TESTS"] === "1" && coreUrl !== undefined;

type SignIn = {
  readonly provider: string;
  readonly params: Readonly<Record<string, string>>;
};

const signInAction = makeFunctionReference<"action", SignIn, { tokens?: { token: string } | null }>(
  "auth:signIn",
);

const coreUsername = makeFunctionReference<"query", Record<string, never>, string | null>(
  "core/viewer:username",
);

const moviesViewer = makeFunctionReference<"query", Record<string, never>, unknown>(
  "account:viewer",
);

const signedIn = async (url: string, params: SignIn): Promise<ConvexHttpClient> => {
  const result = await new ConvexHttpClient(url, { logger: false }).action(signInAction, params);
  const client = new ConvexHttpClient(url, { logger: false });
  const token = result.tokens?.token;

  if (token === undefined) throw new Error("no token");

  client.setAuth(token);

  return client;
};

describe.skipIf(!live)("prototype B: the core's own deployment", () => {
  it("signs in to the core and to old movies side by side", { timeout: 120_000 }, async () => {
    if (coreUrl === undefined || moviesUrl === undefined) return;
    const id = Math.random().toString(36).slice(2, 8);

    const core = await signedIn(coreUrl, {
      provider: "username",
      params: { flow: "signUp", username: `Core-${id}`, password: "password-123" },
    });

    const owner = { email: "owner-a@movies.test", password: "stack-test-password" };

    const movies = await signedIn(moviesUrl, {
      provider: "password",
      params: { flow: "signIn", ...owner },
    }).catch(() =>
      signedIn(moviesUrl, { provider: "password", params: { flow: "signUp", ...owner } }),
    );

    const name = await core.query(coreUsername, {});
    const viewer = await movies.query(moviesViewer, {});

    const crossed = new ConvexHttpClient(moviesUrl, { logger: false });

    const coreToken = await new ConvexHttpClient(coreUrl, { logger: false }).action(signInAction, {
      provider: "username",
      params: { flow: "signIn", username: `core-${id}`, password: "password-123" },
    });

    crossed.setAuth(coreToken.tokens?.token ?? "");

    const refused = await crossed.query(moviesViewer, {}).then(
      () => "accepted",
      () => "refused",
    );

    process.stdout.write(
      `core username=${name}; movies viewer=${JSON.stringify(viewer)}; core token on movies: ${refused}\n`,
    );
    expect(name).toBe(`Core-${id}`);
  });
});
