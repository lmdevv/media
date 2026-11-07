const BROWSERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/Edg\//u, "Edge"],
  [/Firefox\//u, "Firefox"],
  [/Chrome\//u, "Chrome"],
  [/Safari\//u, "Safari"],
];

const SYSTEMS: ReadonlyArray<readonly [RegExp, string]> = [
  [/iPhone/u, "iPhone"],
  [/iPad/u, "iPad"],
  [/Android/u, "Android"],
  [/Mac OS X/u, "Mac"],
  [/Windows/u, "Windows"],
  [/Linux/u, "Linux"],
];

const nameIn = (table: ReadonlyArray<readonly [RegExp, string]>, agent: string): string | null =>
  table.find(([pattern]) => pattern.test(agent))?.[1] ?? null;

/** How this browser appears in the device list, such as `Firefox on Linux`. */
export const deviceName = (agent: string = navigator.userAgent): string => {
  const browser = nameIn(BROWSERS, agent) ?? "Browser";
  const system = nameIn(SYSTEMS, agent);

  return system === null ? browser : `${browser} on ${system}`;
};
