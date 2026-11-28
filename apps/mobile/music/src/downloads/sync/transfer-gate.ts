/**
 * What iOS says of the network the phone uses now (`NWPath`): `expensive` on cellular and on a
 * personal hotspot, `constrained` on a network with Low Data Mode on.
 */
export interface NetworkReading {
  readonly connected: boolean;
  readonly expensive: boolean;
  readonly constrained: boolean;
}

/**
 * Whether the network spends data the person did not offer for downloads: cellular, a personal
 * hotspot, or any network with Low Data Mode on. A network iOS has not reported yet counts as one,
 * so nothing transfers before the first report.
 */
export const meteredOf = (reading: NetworkReading | null): boolean =>
  reading === null || reading.expensive || reading.constrained;

/**
 * Who started a transfer: the person, by downloading or retrying while Low Power Mode is on, or
 * the sync on its own.
 */
export type StartedBy = "person" | "sync";

/** What a transfer's start depends on. */
export interface TransferConditions {
  /** The phone's network is metered (`meteredOf`). */
  readonly metered: boolean;
  /** The Wi-Fi only download setting. */
  readonly wifiOnly: boolean;
  /** Low Power Mode is on. */
  readonly lowPower: boolean;
}

/** Whether a transfer may start now, or what it waits for: Wi-Fi, or Low Power Mode to end. */
export type TransferGate = "run" | "wifi" | "power";

/**
 * The one rule for starting a transfer. Wi-Fi only holds every transfer on a metered network,
 * whoever started it. Low Power Mode holds only those the sync starts on its own.
 */
export const transferGate = (
  conditions: TransferConditions,
  startedBy: StartedBy,
): TransferGate => {
  if (conditions.wifiOnly && conditions.metered) return "wifi";

  if (conditions.lowPower && startedBy === "sync") return "power";

  return "run";
};
