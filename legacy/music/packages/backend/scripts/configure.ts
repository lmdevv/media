/**
 * Sets the deployment environment Convex needs: auth signing keys, the stream signing key, the
 * media service secret, and URLs. Existing values are kept, so running it again is safe.
 *
 *   node scripts/configure.ts [--site-url http://localhost:3001] [--media-url /media]
 *
 * It shells out to `convex env`, so it works against whichever deployment the CLI targets.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";

import { exportJWK, exportPKCS8, generateKeyPair } from "jose";

const { values } = parseArgs({
  options: {
    "site-url": { type: "string", default: "http://localhost:3001" },
    "media-url": { type: "string", default: "/media" },
    "media-secret": { type: "string" },
  },
});

const convex = (args: ReadonlyArray<string>): string =>
  execFileSync("pnpm", ["exec", "convex", ...args], { encoding: "utf8" }).trim();

const existing = new Set(
  convex(["env", "list"])
    .split("\n")
    .map((line) => line.split("=")[0] ?? "")
    .filter((name) => name.length > 0),
);

const set = (name: string, value: string, overwrite: boolean): void => {
  if (existing.has(name) && !overwrite) {
    console.log(`kept ${name}`);

    return;
  }

  convex(["env", "set", name, "--", value]);
  console.log(`set ${name}`);
};

if (!existing.has("JWT_PRIVATE_KEY") || !existing.has("JWKS")) {
  const keys = await generateKeyPair("RS256", { extractable: true });
  const privateKey = await exportPKCS8(keys.privateKey);
  const publicKey = await exportJWK(keys.publicKey);

  set("JWT_PRIVATE_KEY", privateKey.trimEnd().replaceAll("\n", " "), true);
  set("JWKS", JSON.stringify({ keys: [{ use: "sig", ...publicKey }] }), true);
}

set("SITE_URL", values["site-url"], true);

set("MEDIA_PUBLIC_URL", values["media-url"], true);

set("STREAM_SIGNING_KEY", randomBytes(32).toString("base64url"), false);

if (values["media-secret"] === undefined) {
  set("MEDIA_SERVICE_SECRET", randomBytes(32).toString("base64url"), false);
} else {
  set("MEDIA_SERVICE_SECRET", values["media-secret"], true);
}
