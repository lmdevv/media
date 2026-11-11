/**
 * The sign-in boundary (ADR 0007): every sign-in reaches the core through the server's route at
 * `SIGN_IN_PATH`, which knows the client's address, applies the `signIn` budget of `rate-limit.ts`,
 * and hands the core a pass it signed for that one sign-in. The core refuses a sign-in without a
 * good pass, so one sent straight to `auth:signIn` over the Convex API cannot skip the limit.
 *
 * Plain TypeScript with no Effect import, as the core's Convex functions read it.
 */
import { canonicalAddress } from "./rate-limit";
import { fromCanonicalBase64Url, loadDerivedKeyRing, toBase64Url } from "./ticket";
import type { TicketKeysInvalid, TicketResult } from "./ticket";

/** The server's route every client signs in through, with `POST` and a `SignInBody`. */
export const SIGN_IN_PATH = "/api/auth/sign-in";

/** Every sign-in provider of the core. The boundary relays these and no other. */
export const signInProviders = [
  "password",
  "apiKey",
  "deviceCode",
  "setup",
  "invite",
  "reset",
  "tile",
  "guest",
  "grant",
] as const;

/** A sign-in provider of the core. */
export type SignInProvider = (typeof signInProviders)[number];

/** A JSON value, as a sign-in's params hold them. */
export type SignInJson =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<SignInJson>
  | { readonly [key: string]: SignInJson };

/** What a client posts to `SIGN_IN_PATH`: the provider and its params, as `auth:signIn` takes. */
export interface SignInBody {
  readonly provider: SignInProvider;
  readonly params: { readonly [key: string]: SignInJson };
}

/** The largest body the route reads. A tile's proof is the largest params, well under 1 KiB. */
export const SIGN_IN_BODY_MAX_BYTES = 16 * 1024;

/**
 * Codes a refusal can carry besides the command error codes: the device code provider answers
 * `pending` until someone approves the code and `denied` once someone refuses it.
 */
export const signInWaitingCodes = ["pending", "denied"] as const;

/**
 * The HTTP status the boundary answers each refusal code with. A client reads the body's `code`;
 * the status is for logs and proxies.
 */
export const signInRefusalStatus = {
  invalid_args: 400,
  unauthenticated: 401,
  forbidden: 403,
  denied: 403,
  not_found: 404,
  conflict: 409,
  stale_revision: 409,
  pending: 409,
  expired: 410,
  rate_limited: 429,
  internal: 500,
} as const satisfies Readonly<Record<string, number>>;

/** A code a sign-in refusal carries: a command error code, `pending`, or `denied`. */
export type SignInRefusalCode = keyof typeof signInRefusalStatus;

/** The param that carries the pass from the server to the core, beside the provider's own. */
export const PASS_PARAM = "boundaryPass";

/** How long after the server signs a pass the core still takes it. */
export const PASS_LIFETIME_MS = 60 * 1000;

/** How far ahead of the core's clock the server's may run. */
export const PASS_CLOCK_SKEW_MS = 5 * 1000;

/**
 * How long after its pass expires the core keeps a spent nonce. The spender refuses an expired
 * pass on its own, so forgetting the nonce later can never let the pass in again.
 */
export const SPENT_PASS_KEPT_MS = 60 * 1000;

/** The address a pass names for the server's own sign-in with its service key. */
export const SERVER_ADDRESS = "server";

const PASS_VERSION = "p1";

const PASS_KEY_LABEL = "media sign-in pass v1";

const NONCE_BYTES = 16;

const ADDRESS_DIGEST_BYTES = 16;

const MAC_BYTES = 32;

const encoder = new TextEncoder();

const byCodeUnits = (
  [left]: readonly [string, SignInJson],
  [right]: readonly [string, SignInJson],
) => (left < right ? -1 : left > right ? 1 : 0);

const sortedKeys = (_key: string, entry: SignInJson): SignInJson =>
  entry === null || Array.isArray(entry) || !(entry instanceof Object)
    ? entry
    : Object.fromEntries(Object.entries(entry).toSorted(byCodeUnits));

/**
 * `value` as JSON with every object's keys in code unit order, so the server and the core write
 * the same text for the same params, whatever order a hop keeps keys in.
 */
export const canonicalJson = (value: SignInJson): string => JSON.stringify(value, sortedKeys);

const digestOf = async (provider: string, params: SignInJson): Promise<string> =>
  toBase64Url(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        encoder.encode(`${provider}\n${canonicalJson(params)}`),
      ),
    ),
  );

/** What a pass binds: one sign-in, from one address, at one time. */
export interface PassRequest {
  readonly provider: SignInProvider;
  /** The provider's params, without `PASS_PARAM`. */
  readonly params: { readonly [key: string]: SignInJson };
  /**
   * The client's address as the boundary resolved it, or `SERVER_ADDRESS`. The pass names the
   * first 16 bytes of the SHA-256 of its canonical form (`canonicalAddress`), so any text fits,
   * one client has one digest however its address is written, and no address is in the pass.
   */
  readonly address: string;
  /** When the boundary signs, in milliseconds since the epoch. */
  readonly now: number;
}

/** A pass the core accepted, with what it must record so the pass works once. */
export interface CheckedPass {
  /** The pass's random id, unpadded base64url. Not a secret: the core stores it as is. */
  readonly nonce: string;
  /** When the core stops taking the pass. Its spender refuses it from then on. */
  readonly expiresAt: number;
  /** The digest of the address the pass names, unpadded base64url, as the pass carries it. */
  readonly addressDigest: string;
}

/** Why the core refused a pass. Every reason reads the same to the client. */
export type PassRefusal = "missing" | "malformed" | "unknown_key" | "bad_signature" | "expired";

/** A pass refused. The message names the reason, never the pass. */
export class PassRefused extends Error {
  readonly reason: PassRefusal;

  constructor(reason: PassRefusal) {
    super(`Sign-in pass refused: ${reason}`);
    this.name = "PassRefused";
    this.reason = reason;
  }
}

/** Signs and checks passes with keys derived from `MEDIA_TICKET_KEYS`. Holds no key text. */
export interface PassKeys {
  /** A pass for `request`, signed with the ring's first key. */
  readonly sign: (request: PassRequest) => Promise<string>;
  /**
   * Checks `pass`, the value the params held, for a sign-in with `provider` and the rest of
   * `params` at `now`: a listed key signed it for exactly these params less than
   * `PASS_LIFETIME_MS` ago. The caller spends the nonce.
   */
  readonly verify: (
    pass: SignInJson,
    provider: SignInProvider,
    params: SignInJson,
    now: number,
  ) => Promise<TicketResult<CheckedPass, PassRefused>>;
}

const signedText = async (
  head: string,
  provider: SignInProvider,
  params: SignInJson,
): Promise<Uint8Array<ArrayBuffer>> =>
  encoder.encode(`${head}\n${await digestOf(provider, params)}`);

/** A pass as JSON writes it: the pass in quotes, so only a string can match. */
const PASS_SYNTAX =
  /^"(?<pass>p1\.(?<kid>[a-z0-9]{1,16})\.(?<issuedAt>\d{1,15})\.(?<nonce>[\w-]{22})\.(?<address>[\w-]{22})\.(?<mac>[\w-]{43}))"$/u;

const refuse = (reason: PassRefusal): TicketResult<never, PassRefused> => ({
  ok: false,
  error: new PassRefused(reason),
});

/**
 * Reads the ticket key ring `text` (`MEDIA_TICKET_KEYS`) and derives the pass keys from it. The
 * server signs with them and the core checks with them; both already hold the ring.
 */
export const loadPassKeys = async (
  text: string,
): Promise<TicketResult<PassKeys, TicketKeysInvalid>> => {
  const ring = await loadDerivedKeyRing(text, PASS_KEY_LABEL);

  if (!ring.ok) return ring;
  const { keys, signingKeyId } = ring.value;
  const signingKey = keys.get(signingKeyId);

  if (signingKey === undefined) throw new Error("The signing key is missing from its own ring");

  const sign = async ({ provider, params, address, now }: PassRequest): Promise<string> => {
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new RangeError("now must be whole milliseconds since the epoch");
    }

    const nonce = toBase64Url(crypto.getRandomValues(new Uint8Array(NONCE_BYTES)));

    const addressDigest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", encoder.encode(canonicalAddress(address))),
    ).slice(0, ADDRESS_DIGEST_BYTES);

    const head = `${PASS_VERSION}.${signingKeyId}.${String(now)}.${nonce}.${toBase64Url(addressDigest)}`;

    const mac = await crypto.subtle.sign(
      "HMAC",
      signingKey,
      await signedText(head, provider, params),
    );

    return `${head}.${toBase64Url(new Uint8Array(mac))}`;
  };

  const verify: PassKeys["verify"] = async (pass, provider, params, now) => {
    const groups = PASS_SYNTAX.exec(JSON.stringify(pass))?.groups;
    const passText = groups?.["pass"];
    const keyId = groups?.["kid"];
    const nonce = groups?.["nonce"];
    const addressText = groups?.["address"];
    const macText = groups?.["mac"];
    const mac = macText === undefined ? null : fromCanonicalBase64Url(macText, MAC_BYTES);

    if (
      passText === undefined ||
      keyId === undefined ||
      nonce === undefined ||
      addressText === undefined ||
      mac === null ||
      fromCanonicalBase64Url(addressText, ADDRESS_DIGEST_BYTES) === null ||
      fromCanonicalBase64Url(nonce, NONCE_BYTES) === null
    ) {
      return refuse("malformed");
    }

    const key = keys.get(keyId);

    if (key === undefined) return refuse("unknown_key");
    const head = passText.slice(0, passText.lastIndexOf("."));

    if (!(await crypto.subtle.verify("HMAC", key, mac, await signedText(head, provider, params)))) {
      return refuse("bad_signature");
    }

    const issuedAt = Number(groups?.["issuedAt"]);
    const expiresAt = issuedAt + PASS_LIFETIME_MS;

    if (issuedAt > now + PASS_CLOCK_SKEW_MS || now >= expiresAt) return refuse("expired");

    return { ok: true, value: { nonce, expiresAt, addressDigest: addressText } };
  };

  return { ok: true, value: Object.freeze({ sign, verify }) };
};
