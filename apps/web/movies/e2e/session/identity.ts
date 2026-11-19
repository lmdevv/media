import type { Page } from "@playwright/test";
import { Schema } from "effect";

const Modification = Schema.StructWithRest(
  Schema.Struct({
    type: Schema.String,
    queryId: Schema.optionalKey(Schema.Int),
    udfPath: Schema.optionalKey(Schema.String),
  }),
  [Schema.Record(Schema.String, Schema.Json)],
);

const parse = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.StructWithRest(
      Schema.Struct({
        type: Schema.String,
        modifications: Schema.optionalKey(Schema.Array(Modification)),
      }),
      [Schema.Record(Schema.String, Schema.Json)],
    ),
  ),
);

/** Refuses one real identity subscription, then lets its retry reach the core. */
export const refuseIdentityOnce = async (
  page: Page,
  code: "unauthenticated" | "internal" = "unauthenticated",
): Promise<() => number> => {
  const failureMessage = code === "unauthenticated" ? "Session renewing" : "Identity unavailable";
  let refusals = 0;
  await page.routeWebSocket("**/sync", (socket) => {
    const upstream = socket.connectToServer();
    const identities = new Set<number>();
    socket.onMessage((message) => {
      const data = parse(String(message));

      if (data.modifications !== undefined) {
        for (const modification of data.modifications) {
          if (
            modification["udfPath"] === "core/auth/sessions:current" &&
            modification.queryId !== undefined
          )
            identities.add(modification["queryId"]);
        }
      }

      upstream.send(message);
    });
    upstream.onMessage((message) => {
      const data = parse(String(message));

      if (refusals > 0 || data.modifications === undefined) {
        socket.send(message);

        return;
      }

      const modifications = data.modifications.map((modification) => {
        if (
          modification["type"] !== "QueryUpdated" ||
          modification.queryId === undefined ||
          !identities.has(modification["queryId"])
        )
          return modification;
        refusals += 1;

        return {
          type: "QueryFailed",
          queryId: modification["queryId"],
          errorMessage: failureMessage,
          errorData: { code, message: failureMessage },
          logLines: [],
          journal: null,
        };
      });

      socket.send(JSON.stringify({ ...data, modifications }));
    });
  });

  return () => refusals;
};
