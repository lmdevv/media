/**
 * How often one client address may call what needs no session, before the server answers 429
 * (ADR 0007). The core never sees a client address, so the server applies these in front of it;
 * the core keeps its own limits per person and per link. Each door is a token bucket: up to
 * `burst` calls at once, refilling at `perSecond`. An address is the client the server resolves
 * through `MEDIA_TRUSTED_PROXIES` (ADR 0027), so every client behind an untrusted proxy is one.
 */
export const addressBudgets = {
  /**
   * A sign-in with any provider through the server's boundary (`sign-in.ts`), a guest opening a
   * share link and each poll of a device code included. A device code polls every 5 seconds,
   * which this door refills at, so a waiting device stays inside it.
   */
  signIn: { burst: 10, perSecond: 0.2 },
  /** Any other call that needs no session, such as looking up an invite or starting a device code. */
  public: { burst: 60, perSecond: 2 },
} as const satisfies Readonly<
  Record<string, { readonly burst: number; readonly perSecond: number }>
>;

/** A door limited per client address. */
export type Door = keyof typeof addressBudgets;

/** Every door, for a server that keeps one bucket per door and address. */
export const doors: ReadonlyArray<Door> = ["signIn", "public"];

/** What one door holds for one address: the calls it may still take, as of `updatedAt` (ms). */
export interface AddressBucket {
  readonly tokens: number;
  readonly updatedAt: number;
}

/** A call admitted or refused, with the bucket to keep for the next call through the door. */
export type Admission =
  | { readonly admitted: true; readonly bucket: AddressBucket }
  | {
      readonly admitted: false;
      readonly bucket: AddressBucket;
      /** Whole seconds until the door admits one call, for a `Retry-After` header. */
      readonly retryAfterSeconds: number;
    };

/**
 * Decides one call through `door` from an address whose bucket is `bucket`, or none yet, at
 * `now` in milliseconds. Pure: the caller keeps each address's bucket. A clock that steps back
 * refills nothing.
 */
export const admit = (door: Door, bucket: AddressBucket | undefined, now: number): Admission => {
  const { burst, perSecond } = addressBudgets[door];
  const elapsed = bucket === undefined ? 0 : Math.max(0, now - bucket.updatedAt);
  const updatedAt = bucket === undefined ? now : Math.max(now, bucket.updatedAt);
  const tokens = Math.min(burst, (bucket?.tokens ?? burst) + (elapsed / 1000) * perSecond);

  if (tokens >= 1) return { admitted: true, bucket: { tokens: tokens - 1, updatedAt } };

  return {
    admitted: false,
    bucket: { tokens, updatedAt },
    retryAfterSeconds: Math.ceil((1 - tokens) / perSecond),
  };
};
