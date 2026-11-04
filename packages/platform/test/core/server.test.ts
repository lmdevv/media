import { ConvexHttpClient } from "convex/browser";
import { getFunctionName, makeFunctionReference } from "convex/server";
import { describe, expect, it } from "vitest";

import { api } from "../../convex/_generated/api";
import packageJson from "../../package.json" with { type: "json" };
import { ensureOwner } from "../sign-in";
import { coreStackFromEnvFile } from "../stack-env";

const stack = coreStackFromEnvFile();

describe.skipIf(stack === undefined)("core.server.info", { timeout: 60_000 }, () => {
  it("tells a caller with no session the server's name, version, and that it has an owner", async () => {
    if (stack === undefined) return;

    const client = new ConvexHttpClient(stack.url, { logger: false });

    await ensureOwner(stack);

    expect(await client.query(api.core.server.info, {})).toEqual({
      name: "[media]",
      version: packageJson.version,
      hasOwner: true,
    });
  });

  it("rejects arguments the declaration does not allow", async () => {
    if (stack === undefined) return;

    const client = new ConvexHttpClient(stack.url, { logger: false });

    const withExtraArgument = makeFunctionReference<"query", { readonly verbose: number }, null>(
      getFunctionName(api.core.server.info),
    );

    await expect(client.query(withExtraArgument, { verbose: 1 })).rejects.toThrow(
      /ArgumentValidationError/u,
    );
  });
});
