import { ConvexClient } from "convex/browser";
import type { FunctionArgs, FunctionReturnType } from "convex/server";

import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import type { SignedIn } from "./sign-in";
import type { CoreStack } from "./stack-env";

/** A device's report, as `core.connect.player.report` takes it. */
export type Report = FunctionArgs<typeof api.core.connect.player.report>;

/** A Connect target as `core.connect.targets.list` shows it. */
export type Target = FunctionReturnType<typeof api.core.connect.targets.list>[number];

/** Playing `domain` at `positionMs` on the device itself, having applied `applied`. */
export const playing = (
  positionMs: number,
  applied = 0,
  domain: "movies" | "music" = "movies",
): Report => ({
  output: { kind: "local" },
  playback: { domain, playing: true, positionMs },
  applied,
});

/** Reports `sent` from the device `device` is signed in on. */
export const report = (device: SignedIn, sent: Report) =>
  device.client.mutation(api.core.connect.player.report, sent);

/** The targets `controller` may control. */
export const targets = (controller: SignedIn) =>
  controller.client.query(api.core.connect.targets.list, {});

/** The target `deviceId` in `shown`, or undefined. */
export const targetIn = (
  shown: ReadonlyArray<Target>,
  deviceId: Id<"devices">,
): Target | undefined => shown.find((target) => target.deviceId === deviceId);

export const control = (
  controller: SignedIn,
  deviceId: Id<"devices">,
  change: Omit<FunctionArgs<typeof api.core.connect.targets.control>, "deviceId">,
) => controller.client.mutation(api.core.connect.targets.control, { deviceId, ...change });

/** A websocket client signed in as `signedIn`, which pushes query updates as they commit. */
export const live = (stack: CoreStack, signedIn: SignedIn): ConvexClient => {
  const client = new ConvexClient(stack.url, { logger: false });

  client.setAuth(() => Promise.resolve(signedIn.token));

  return client;
};
