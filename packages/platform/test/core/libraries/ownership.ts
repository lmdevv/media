import { createHash } from "node:crypto";

import { Schema } from "effect";

import type { ContentDomain } from "../../../commands/scopes";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { runServer } from "../../service";
import type { CoreStack } from "../../stack-env";
import { retrying } from "../jobs/driver";

const held = <Value extends Schema.Top>(value: Value) =>
  Schema.Union([
    Schema.Struct({ outcome: Schema.Literal("held"), value }),
    Schema.Struct({ outcome: Schema.Literals(["canceled", "lost"]) }),
  ]);

const Target = held(Schema.Struct({ folders: Schema.Array(Schema.String) }));

const Claimed = held(
  Schema.Union([
    Schema.Struct({ claimed: Schema.Literal(true) }),
    Schema.Struct({
      claimed: Schema.Literal(false),
      folder: Schema.String,
      rescans: Schema.Boolean,
    }),
  ]),
);

/**
 * A stand-in identity for `folder`, as the server reads one on disk: its own device number from a
 * hash of the path, so two test folders never share one.
 */
const identityOf = (folder: string): string =>
  `${Number.parseInt(createHash("sha256").update(folder).digest("hex").slice(0, 12), 16)}:1`;

/**
 * Claims the folders of the scan `lease` holds, as the server does before any write (ADR 0024,
 * "Folder identity"), each by its stand-in identity and without a source, and answers how the
 * lease answered.
 *
 * @throws Error when the claim is refused, which a test's own folders never are.
 */
export const claimOwnFolders = async (
  stack: CoreStack,
  kind: ContentDomain,
  lease: { readonly jobId: Id<"jobs">; readonly attempt: number },
): Promise<"held" | "canceled" | "lost"> => {
  const target = await retrying(() =>
    runServer(stack, api.core.scans.target, { lease, kind }, Target),
  );

  if (target.outcome !== "held") return target.outcome;

  const claimed = await retrying(() =>
    runServer(
      stack,
      api.core.scans.claimFolders,
      {
        lease,
        kind,
        bootId: null,
        folders: target.value.folders.map((folder) => ({
          folder,
          chain: [identityOf(folder)],
          source: null,
        })),
      },
      Claimed,
    ),
  );

  if (claimed.outcome !== "held") return claimed.outcome;

  if (!claimed.value.claimed) throw new Error(`The test's own ${claimed.value.folder} was refused`);

  return "held";
};
