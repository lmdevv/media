import { execFileSync } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

import { TICKET_KEY_BYTES, TICKET_KEYS_SETTING } from "@media/contracts/ticket";

const convexBin = fileURLToPath(new URL("../node_modules/.bin/convex", import.meta.url));

// The thrown error would carry the command line, and with it a secret value being set.
const convex = (args: ReadonlyArray<string>): string => {
  try {
    return execFileSync(convexBin, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    }).trim();
  } catch {
    throw new Error(`convex ${args.slice(0, 2).join(" ")} failed; see its output above`);
  }
};

const names = new Set(
  convex(["env", "list"])
    .split("\n")
    .flatMap((line) => {
      const separator = line.indexOf("=");

      return separator > 0 ? [line.slice(0, separator)] : [];
    }),
);

if (names.has("JWT_PRIVATE_KEY") && names.has("JWKS")) {
  process.stderr.write("kept JWT_PRIVATE_KEY and JWKS\n");
} else {
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKey = keys.privateKey.export({ type: "pkcs8", format: "pem" });
  const publicKey = keys.publicKey.export({ format: "jwk" });

  convex(["env", "set", "JWT_PRIVATE_KEY", "--", privateKey.trimEnd().replaceAll("\n", " ")]);
  convex(["env", "set", "JWKS", "--", JSON.stringify({ keys: [{ use: "sig", ...publicKey }] })]);
  process.stderr.write("set JWT_PRIVATE_KEY and JWKS\n");
}

if (names.has(TICKET_KEYS_SETTING)) {
  process.stderr.write(`kept ${TICKET_KEYS_SETTING}\n`);
} else {
  const day = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const keyId = `k${day}${randomBytes(3).toString("hex")}`;
  const key = randomBytes(TICKET_KEY_BYTES).toString("base64url");

  convex(["env", "set", TICKET_KEYS_SETTING, "--", `${keyId}:${key}`]);
  process.stderr.write(`set ${TICKET_KEYS_SETTING}\n`);
}
