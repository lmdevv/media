const HOUR_MS = 60 * 60 * 1000;

/**
 * A device silent for this long drops out of the device list. Every closed tab or browser profile
 * registers a device, so without a cutoff the "Play on" list keeps them forever. A day keeps a
 * laptop that slept overnight listed while hiding browsers that are gone.
 */
export const DEVICE_LISTED_MS = 24 * HOUR_MS;

/**
 * A device silent for this long is deleted by the daily prune. It is far past the listing cutoff
 * so a row is never deleted while it could still be listed, and a device that comes back
 * registers again with its next heartbeat.
 */
export const DEVICE_RETAINED_MS = 30 * 24 * HOUR_MS;

/** At most this many recently seen devices are read for the list; the kept ones come on top. */
export const DEVICE_LIST_LIMIT = 50;

/** What the listing policy reads from a device row. */
interface Seen {
  readonly deviceId: string;
  readonly lastSeenAt: number;
}

/**
 * The devices to list at `now`: those heard from within `DEVICE_LISTED_MS`, plus every device in
 * `keep` however long it has been silent (the session's active device and the device asking).
 */
export const listedDevices = <Device extends Seen>(
  devices: ReadonlyArray<Device>,
  now: number,
  keep: ReadonlySet<string>,
): Array<Device> =>
  devices.filter(
    (device) => keep.has(device.deviceId) || now - device.lastSeenAt < DEVICE_LISTED_MS,
  );
