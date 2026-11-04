import { HealthResponse } from "@media/contracts/media-playback";
import { Option, Schema } from "effect";

const decodeHealth = Schema.decodeUnknownOption(Schema.fromJsonString(HealthResponse));

/** Whether a media service's health body says it is signed in to Convex. */
export const isConnected = (body: string): boolean =>
  Option.exists(decodeHealth(body), (health) => health.backend === "connected");
