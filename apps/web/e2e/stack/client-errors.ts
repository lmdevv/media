import { DIAGNOSTICS_ROUTES } from "@media/contracts/diagnostics";
import { Schema } from "effect";

const decodeSession = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ token: Schema.String })),
);

const decodeClientError = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      annotations: Schema.Struct({ kind: Schema.String, errorMessage: Schema.String }),
    }),
  ),
);

/** The apps' error reports in the retained log as `<kind> <message>`, read with an admin session. */
export const clientErrors = async (
  mediaUrl: string,
  storedSession: string | null,
): Promise<ReadonlyArray<string>> => {
  const { token } = decodeSession(storedSession);

  const response = await fetch(`${mediaUrl}${DIAGNOSTICS_ROUTES.logs}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ grep: "Client.error" }),
  });

  return (await response.text())
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => decodeClientError(line).annotations)
    .map(({ kind, errorMessage }) => `${kind} ${errorMessage}`);
};
