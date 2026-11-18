import * as Device from "expo-device";

import { DEVICE_FAMILY } from "./this-device";

const MAX_NAME_LENGTH = 80;

/**
 * How this device names itself in the person's devices: its name in Settings where iOS shares it,
 * else the model ("iPhone 17"), else what it is ("iPad").
 */
export const deviceName = (): string =>
  (Device.deviceName ?? Device.modelName ?? DEVICE_FAMILY).trim().slice(0, MAX_NAME_LENGTH) ||
  DEVICE_FAMILY;
