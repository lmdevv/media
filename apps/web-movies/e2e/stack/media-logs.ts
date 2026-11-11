import { LogRecord } from "@media/contracts/diagnostics";
import { Option, Schema } from "effect";

import type { MediaService } from "./media-service";

const decodeRecord = Schema.decodeUnknownOption(Schema.fromJsonString(LogRecord));

/** What `service` logged so far under `message` about `streamId`, oldest first. */
export const loggedAbout = (
  service: MediaService | undefined,
  message: string,
  streamId: string,
): ReadonlyArray<LogRecord> =>
  (service?.logs() ?? "")
    .split("\n")
    .flatMap((line) => Option.toArray(decodeRecord(line)))
    .filter((record) => record.message === message && record.annotations["streamId"] === streamId);
