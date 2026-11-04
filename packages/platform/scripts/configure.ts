/**
 * PROTOTYPE B: sets Convex Auth's JWT_PRIVATE_KEY and JWKS on the core deployment the CLI targets.
 * Safe to run again: existing keys are kept.
 */
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { fileURLToPath } from "node:url";

const convexBin = fileURLToPath(new URL("../node_modules/.bin/convex", import.meta.url));

const convex = (args: ReadonlyArray<string>): string =>
  execFileSync(convexBin, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();

const listed = convex(["env", "list"]);

if (listed.includes("JWT_PRIVATE_KEY=") && listed.includes("JWKS=")) {
  process.stderr.write("kept JWT_PRIVATE_KEY and JWKS\n");
} else {
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKey = keys.privateKey.export({ type: "pkcs8", format: "pem" });
  const publicKey = keys.publicKey.export({ format: "jwk" });

  convex(["env", "set", "JWT_PRIVATE_KEY", "--", privateKey.trimEnd().replaceAll("\n", " ")]);
  convex(["env", "set", "JWKS", "--", JSON.stringify({ keys: [{ use: "sig", ...publicKey }] })]);
  process.stderr.write("set JWT_PRIVATE_KEY and JWKS\n");
}
