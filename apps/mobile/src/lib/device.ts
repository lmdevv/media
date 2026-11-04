import { DeviceId } from "@media/contracts/ids";
import * as Crypto from "expo-crypto";
import * as Device from "expo-device";

import { readValue, writeValue } from "./secure-storage";

const DEVICE_ID_KEY = "movies.deviceId";

const MAX_NAME_LENGTH = 80;

let cached: DeviceId | null = null;

/** This install's device ID, created and remembered on first use. */
export const deviceId = (): DeviceId => {
  if (cached !== null) return cached;

  const stored = readValue(DEVICE_ID_KEY);
  const id = DeviceId.make(stored ?? `ios-${Crypto.randomUUID()}`);

  if (stored === null) writeValue(DEVICE_ID_KEY, id);
  cached = id;

  return id;
};

/** The phone's name, such as `Alex's iPhone`, else its model, else `iPhone`. */
export const deviceName = (): string =>
  (Device.deviceName ?? Device.modelName ?? "iPhone").trim().slice(0, MAX_NAME_LENGTH) || "iPhone";
