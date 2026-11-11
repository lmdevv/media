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

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u;

const HEXTET = /^[\da-f]{1,4}$/u;

/** The four octets of a dotted IPv4 address, or null. */
const ipv4Octets = (text: string): ReadonlyArray<number> | null => {
  const groups = IPV4.exec(text);

  if (groups === null) return null;
  const octets = groups.slice(1).map(Number);

  return octets.every((octet) => octet <= 255) ? octets : null;
};

/** The colon-separated groups of one side of an IPv6 address's `::`. */
const groupsOf = (part: string): ReadonlyArray<string> => (part === "" ? [] : part.split(":"));

/** The eight 16-bit groups of an IPv6 address, an embedded IPv4 tail included, or null. */
const ipv6Hextets = (text: string): ReadonlyArray<number> | null => {
  const lastColon = text.lastIndexOf(":");
  const tail = ipv4Octets(text.slice(lastColon + 1));
  const [first = 0, second = 0, third = 0, fourth = 0] = tail ?? [];

  const hexText =
    tail === null
      ? text
      : `${text.slice(0, lastColon + 1)}${((first << 8) | second).toString(16)}:${((third << 8) | fourth).toString(16)}`;

  const halves = hexText.split("::");

  if (halves.length > 2) return null;
  const head = groupsOf(halves[0] ?? "");
  const rest = halves.length === 2 ? groupsOf(halves[1] ?? "") : [];
  const missing = 8 - head.length - rest.length;

  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = [...head, ...Array.from({ length: missing }, () => "0"), ...rest];

  return groups.every((group) => HEXTET.test(group))
    ? groups.map((group) => Number.parseInt(group, 16))
    : null;
};

/** `hextets` in RFC 5952's form: lowercase, no leading zeros, the longest run of zeros as `::`. */
const compressed = (hextets: ReadonlyArray<number>): string => {
  let best = { start: -1, length: 0 };
  let run = { start: -1, length: 0 };

  for (const [index, hextet] of hextets.entries()) {
    run =
      hextet === 0
        ? { start: run.length === 0 ? index : run.start, length: run.length + 1 }
        : { start: -1, length: 0 };

    if (run.length > best.length) best = run;
  }

  const text = hextets.map((hextet) => hextet.toString(16));

  if (best.length < 2) return text.join(":");

  return `${text.slice(0, best.start).join(":")}::${text.slice(best.start + best.length).join(":")}`;
};

/**
 * The one written form of a client address, for every key and digest made from one: a rate-limit
 * bucket and a sign-in pass's address. An IPv4-mapped IPv6 address becomes its IPv4 address, IPv6
 * is lowercased and compressed (RFC 5952), and brackets and a zone id are dropped, so one client
 * never counts as two. Text that is no IP address, such as `unknown`, is kept as it is, trimmed.
 */
export const canonicalAddress = (address: string): string => {
  const trimmed = address.trim();
  const unbracketed = /^\[(.*)\]$/u.exec(trimmed)?.[1] ?? trimmed;
  const ipv4 = ipv4Octets(unbracketed);

  if (ipv4 !== null) return ipv4.join(".");

  const unzoned = unbracketed.split("%", 1)[0]?.toLowerCase() ?? "";

  if (!unzoned.includes(":")) return trimmed;
  const hextets = ipv6Hextets(unzoned);

  if (hextets === null) return trimmed;
  const mapped = hextets.slice(0, 5).every((hextet) => hextet === 0) && hextets[5] === 0xffff;

  if (mapped) {
    const [, , , , , , high = 0, low = 0] = hextets;

    return [high >> 8, high & 255, low >> 8, low & 255].join(".");
  }

  return compressed(hextets);
};
