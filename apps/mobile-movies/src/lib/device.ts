import * as Device from "expo-device";

const MAX_NAME_LENGTH = 80;

/** The phone's name, such as `Alex's iPhone`, else its model, else `iPhone`. */
export const deviceName = (): string =>
  (Device.deviceName ?? Device.modelName ?? "iPhone").trim().slice(0, MAX_NAME_LENGTH) || "iPhone";
