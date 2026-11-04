/**
 * Ticket test vectors: the bytes `ticket.ts` must issue and the answers `admit` must give. Every
 * MAC was computed with Node's `createHmac`, never with `ticket.ts`. The keys are test keys only.
 */
import type {
  PersonalTicketRequest,
  SessionState,
  ShareableTicketRequest,
  TicketClaims,
  TicketRefusalReason,
  TicketRoute,
} from "./ticket";

/** `MEDIA_TICKET_KEYS` values made of test keys: `k1` is the bytes 0 to 31, `k2` 32 bytes of 7. */
export const TICKET_TEST_KEYS = {
  k1: "k1:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
  k2: "k2:BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc",
  /** `k2` signs and `k1` still verifies: the middle of a rotation. */
  rotated:
    "k2:BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc,k1:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
} as const;

/** One ticket, how a ring issues it, and what `admit` answers for it on a route at a time. */
export interface TicketVector {
  readonly name: string;
  /** The `MEDIA_TICKET_KEYS` value of the ring that issues and admits. */
  readonly keys: string;
  /** The request that issues exactly `ticket`, or null for a ticket no ring would issue. */
  readonly issue:
    | { readonly kind: "personal"; readonly request: PersonalTicketRequest }
    | { readonly kind: "shareable"; readonly request: ShareableTicketRequest }
    | null;
  readonly ticket: string;
  readonly route: TicketRoute;
  /** The verifier's clock, in milliseconds since the epoch. */
  readonly now: number;
  /** What the session reader answers. */
  readonly session: SessionState;
  readonly admits:
    | { readonly ok: true; readonly claims: TicketClaims }
    | { readonly ok: false; readonly reason: TicketRefusalReason };
}

const principal = {
  userId: "j5701yqbmrsg2s1bjvhwj6x5a97t3qd5",
  sessionId: "jx76k6ga36g7tfhf9vtm1yahbs7t3ccv",
} as const;

const file = { kind: "file", id: "kd7ay8r0ty1ry6q9y6eqvdc3y97t2wmf" } as const;

const artwork = {
  kind: "artwork",
  id: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
} as const;

const playRoute: TicketRoute = { purposes: ["play"], resource: file };

const originalFileRoute: TicketRoute = { purposes: ["play", "download"], resource: file };

const artworkRoute: TicketRoute = { purposes: ["image"], resource: artwork };

const playClaims: TicketClaims = {
  kind: "personal",
  principal,
  purpose: "play",
  resource: file,
  issuedAt: 1760000000000,
  expiresAt: 1760021600000,
};

const downloadClaims: TicketClaims = { ...playClaims, purpose: "download" };

const artworkClaims: TicketClaims = {
  kind: "shareable",
  purpose: "image",
  resource: artwork,
  issuedAt: 1759968000000,
  expiresAt: 1761177600000,
};

/** Admitted vectors first, then refused ones in the order `admit` checks. */
export const TICKET_TEST_VECTORS: ReadonlyArray<TicketVector> = [
  {
    name: "a personal play ticket",
    keys: TICKET_TEST_KEYS.k1,
    issue: {
      kind: "personal",
      request: { principal, resource: file, purpose: "play", now: 1760000000500 },
    },
    ticket:
      "t1.k1.media.1760000000.1760021600.play.file.kd7ay8r0ty1ry6q9y6eqvdc3y97t2wmf.s.j5701yqbmrsg2s1bjvhwj6x5a97t3qd5.jx76k6ga36g7tfhf9vtm1yahbs7t3ccv.fonybPBe6YpKNEd2U_-Ih0XeYvD2LjUny3thssRwYRk",
    route: playRoute,
    now: 1760000001500,
    session: "live",
    admits: { ok: true, claims: playClaims },
  },
  {
    name: "its download twin, on a route that serves both",
    keys: TICKET_TEST_KEYS.k1,
    issue: {
      kind: "personal",
      request: { principal, resource: file, purpose: "download", now: 1760000000500 },
    },
    ticket:
      "t1.k1.media.1760000000.1760021600.download.file.kd7ay8r0ty1ry6q9y6eqvdc3y97t2wmf.s.j5701yqbmrsg2s1bjvhwj6x5a97t3qd5.jx76k6ga36g7tfhf9vtm1yahbs7t3ccv.QnCSlJIpDXNjeJrZqYzsHCh29vYjPrF59eUJSfCVDu8",
    route: originalFileRoute,
    now: 1760000001500,
    session: "live",
    admits: { ok: true, claims: downloadClaims },
  },
  {
    name: "a shareable artwork ticket issued at its bucket's start",
    keys: TICKET_TEST_KEYS.k1,
    issue: { kind: "shareable", request: { resource: artwork, now: 1759968000000 } },
    ticket:
      "t1.k1.media.1759968000.1761177600.image.artwork.9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08.a.DR0XtbxV4JyhEbXDUdCOFXLVm8llhCpm7uRFS4VKmic",
    route: artworkRoute,
    now: 1760000001500,
    session: "live",
    admits: { ok: true, claims: artworkClaims },
  },
  {
    name: "the same artwork ticket issued 1 ms later",
    keys: TICKET_TEST_KEYS.k1,
    issue: { kind: "shareable", request: { resource: artwork, now: 1759968000001 } },
    ticket:
      "t1.k1.media.1759968000.1761177600.image.artwork.9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08.a.DR0XtbxV4JyhEbXDUdCOFXLVm8llhCpm7uRFS4VKmic",
    route: artworkRoute,
    now: 1760000001500,
    session: "live",
    admits: { ok: true, claims: artworkClaims },
  },
  {
    name: "the same artwork ticket issued mid-bucket",
    keys: TICKET_TEST_KEYS.k1,
    issue: { kind: "shareable", request: { resource: artwork, now: 1760000000500 } },
    ticket:
      "t1.k1.media.1759968000.1761177600.image.artwork.9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08.a.DR0XtbxV4JyhEbXDUdCOFXLVm8llhCpm7uRFS4VKmic",
    route: artworkRoute,
    now: 1760000001500,
    session: "live",
    admits: { ok: true, claims: artworkClaims },
  },
  {
    name: "the same artwork ticket issued at the bucket's last millisecond",
    keys: TICKET_TEST_KEYS.k1,
    issue: { kind: "shareable", request: { resource: artwork, now: 1760572799999 } },
    ticket:
      "t1.k1.media.1759968000.1761177600.image.artwork.9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08.a.DR0XtbxV4JyhEbXDUdCOFXLVm8llhCpm7uRFS4VKmic",
    route: artworkRoute,
    now: 1760572799999,
    session: "live",
    admits: { ok: true, claims: artworkClaims },
  },
  {
    name: "the next bucket's artwork ticket",
    keys: TICKET_TEST_KEYS.k1,
    issue: { kind: "shareable", request: { resource: artwork, now: 1760572800000 } },
    ticket:
      "t1.k1.media.1760572800.1761782400.image.artwork.9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08.a.a_g1OiEhC9YAdODS621nef17fq8S6mH39IyWPEReQVY",
    route: artworkRoute,
    now: 1760572800000,
    session: "live",
    admits: {
      ok: true,
      claims: {
        kind: "shareable",
        purpose: "image",
        resource: artwork,
        issuedAt: 1760572800000,
        expiresAt: 1761782400000,
      },
    },
  },
  {
    name: "a ticket the rotated ring signs with its new key",
    keys: TICKET_TEST_KEYS.rotated,
    issue: {
      kind: "personal",
      request: { principal, resource: file, purpose: "play", now: 1760000000500 },
    },
    ticket:
      "t1.k2.media.1760000000.1760021600.play.file.kd7ay8r0ty1ry6q9y6eqvdc3y97t2wmf.s.j5701yqbmrsg2s1bjvhwj6x5a97t3qd5.jx76k6ga36g7tfhf9vtm1yahbs7t3ccv.8Aj8GjGDlvmVUiZ1wkI-3IdutdYPxH0xlsq4kSP2VkI",
    route: playRoute,
    now: 1760000001500,
    session: "live",
    admits: { ok: true, claims: playClaims },
  },
  {
    name: "a ticket the old key signed, on the rotated ring",
    keys: TICKET_TEST_KEYS.rotated,
    issue: null,
    ticket:
      "t1.k1.media.1760000000.1760021600.play.file.kd7ay8r0ty1ry6q9y6eqvdc3y97t2wmf.s.j5701yqbmrsg2s1bjvhwj6x5a97t3qd5.jx76k6ga36g7tfhf9vtm1yahbs7t3ccv.fonybPBe6YpKNEd2U_-Ih0XeYvD2LjUny3thssRwYRk",
    route: playRoute,
    now: 1760000001500,
    session: "live",
    admits: { ok: true, claims: playClaims },
  },
  {
    name: "a ticket presented a full clock skew before it was issued",
    keys: TICKET_TEST_KEYS.k1,
    issue: null,
    ticket:
      "t1.k1.media.1760000000.1760021600.play.file.kd7ay8r0ty1ry6q9y6eqvdc3y97t2wmf.s.j5701yqbmrsg2s1bjvhwj6x5a97t3qd5.jx76k6ga36g7tfhf9vtm1yahbs7t3ccv.fonybPBe6YpKNEd2U_-Ih0XeYvD2LjUny3thssRwYRk",
    route: playRoute,
    now: 1759999940000,
    session: "live",
    admits: { ok: true, claims: playClaims },
  },
  {
    name: "a ticket presented 1 ms before it expires",
    keys: TICKET_TEST_KEYS.k1,
    issue: null,
    ticket:
      "t1.k1.media.1760000000.1760021600.play.file.kd7ay8r0ty1ry6q9y6eqvdc3y97t2wmf.s.j5701yqbmrsg2s1bjvhwj6x5a97t3qd5.jx76k6ga36g7tfhf9vtm1yahbs7t3ccv.fonybPBe6YpKNEd2U_-Ih0XeYvD2LjUny3thssRwYRk",
    route: playRoute,
    now: 1760021599999,
    session: "live",
    admits: { ok: true, claims: playClaims },
  },
  {
    name: "an old playback token's version",
    keys: TICKET_TEST_KEYS.k1,
    issue: null,
    ticket:
      "v1.k1.media.1760000000.1760021600.play.file.kd7ay8r0ty1ry6q9y6eqvdc3y97t2wmf.s.j5701yqbmrsg2s1bjvhwj6x5a97t3qd5.jx76k6ga36g7tfhf9vtm1yahbs7t3ccv.fonybPBe6YpKNEd2U_-Ih0XeYvD2LjUny3thssRwYRk",
    route: playRoute,
    now: 1760000001500,
    session: "live",
    admits: { ok: false, reason: "malformed" },
  },
  {
    name: "an extra segment",
    keys: TICKET_TEST_KEYS.k1,
    issue: null,
    ticket:
      "t1.k1.media.1760000000.1760021600.play.file.kd7ay8r0ty1ry6q9y6eqvdc3y97t2wmf.s.j5701yqbmrsg2s1bjvhwj6x5a97t3qd5.jx76k6ga36g7tfhf9vtm1yahbs7t3ccv.x.fonybPBe6YpKNEd2U_-Ih0XeYvD2LjUny3thssRwYRk",
    route: playRoute,
    now: 1760000001500,
    session: "live",
    admits: { ok: false, reason: "malformed" },
  },
  {
    name: "over 512 characters",
    keys: TICKET_TEST_KEYS.k1,
    issue: null,
    ticket:
      "t1.k1.media.1760000000.1760021600.play.file.ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff.s.j5701yqbmrsg2s1bjvhwj6x5a97t3qd5.jx76k6ga36g7tfhf9vtm1yahbs7t3ccv.fonybPBe6YpKNEd2U_-Ih0XeYvD2LjUny3thssRwYRk",
    route: playRoute,
    now: 1760000001500,
    session: "live",
    admits: { ok: false, reason: "malformed" },
  },
  {
    name: "a signed shareable ticket for play",
    keys: TICKET_TEST_KEYS.k1,
    issue: null,
    ticket:
      "t1.k1.media.1759968000.1761177600.play.artwork.9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08.a.KGrUtIjvs3I4ZGkOANJWlUZBxG3RkqixbyvU6D4bFGY",
    route: playRoute,
    now: 1760000001500,
    session: "live",
    admits: { ok: false, reason: "malformed" },
  },
  {
    name: "a signed ticket whose expiry has a leading zero",
    keys: TICKET_TEST_KEYS.k1,
    issue: null,
    ticket:
      "t1.k1.media.1760000000.01760021600.play.file.kd7ay8r0ty1ry6q9y6eqvdc3y97t2wmf.s.j5701yqbmrsg2s1bjvhwj6x5a97t3qd5.jx76k6ga36g7tfhf9vtm1yahbs7t3ccv.IVrNpkLmuAVW2TyZzsGDiSi1MFXPcQf3ovTwWVZMx8I",
    route: playRoute,
    now: 1760000001500,
    session: "live",
    admits: { ok: false, reason: "malformed" },
  },
  {
    name: "a ticket whose key the ring does not list",
    keys: TICKET_TEST_KEYS.k1,
    issue: null,
    ticket:
      "t1.k2.media.1760000000.1760021600.play.file.kd7ay8r0ty1ry6q9y6eqvdc3y97t2wmf.s.j5701yqbmrsg2s1bjvhwj6x5a97t3qd5.jx76k6ga36g7tfhf9vtm1yahbs7t3ccv.8Aj8GjGDlvmVUiZ1wkI-3IdutdYPxH0xlsq4kSP2VkI",
    route: playRoute,
    now: 1760000001500,
    session: "live",
    admits: { ok: false, reason: "unknown_key" },
  },
  {
    name: "a MAC whose last character aliases the canonical one",
    keys: TICKET_TEST_KEYS.k1,
    issue: null,
    ticket:
      "t1.k1.media.1760000000.1760021600.play.file.kd7ay8r0ty1ry6q9y6eqvdc3y97t2wmf.s.j5701yqbmrsg2s1bjvhwj6x5a97t3qd5.jx76k6ga36g7tfhf9vtm1yahbs7t3ccv.fonybPBe6YpKNEd2U_-Ih0XeYvD2LjUny3thssRwYRl",
    route: playRoute,
    now: 1760000001500,
    session: "live",
    admits: { ok: false, reason: "malformed" },
  },
  {
    name: "one changed MAC character",
    keys: TICKET_TEST_KEYS.k1,
    issue: null,
    ticket:
      "t1.k1.media.1760000000.1760021600.play.file.kd7ay8r0ty1ry6q9y6eqvdc3y97t2wmf.s.j5701yqbmrsg2s1bjvhwj6x5a97t3qd5.jx76k6ga36g7tfhf9vtm1yahbs7t3ccv.AonybPBe6YpKNEd2U_-Ih0XeYvD2LjUny3thssRwYRk",
    route: playRoute,
    now: 1760000001500,
    session: "live",
    admits: { ok: false, reason: "bad_signature" },
  },
  {
    name: "one changed expiry digit",
    keys: TICKET_TEST_KEYS.k1,
    issue: null,
    ticket:
      "t1.k1.media.1760000000.1760021601.play.file.kd7ay8r0ty1ry6q9y6eqvdc3y97t2wmf.s.j5701yqbmrsg2s1bjvhwj6x5a97t3qd5.jx76k6ga36g7tfhf9vtm1yahbs7t3ccv.fonybPBe6YpKNEd2U_-Ih0XeYvD2LjUny3thssRwYRk",
    route: playRoute,
    now: 1760000001500,
    session: "live",
    admits: { ok: false, reason: "bad_signature" },
  },
  {
    name: "another key's MAC under a listed key id",
    keys: TICKET_TEST_KEYS.k1,
    issue: null,
    ticket:
      "t1.k1.media.1760000000.1760021600.play.file.kd7ay8r0ty1ry6q9y6eqvdc3y97t2wmf.s.j5701yqbmrsg2s1bjvhwj6x5a97t3qd5.jx76k6ga36g7tfhf9vtm1yahbs7t3ccv.z91QxRA8jbGD0hNdHGIhObpqLH2miz5quuQk7DbXgz4",
    route: playRoute,
    now: 1760000001500,
    session: "live",
    admits: { ok: false, reason: "bad_signature" },
  },
  {
    name: "a signed ticket for another audience",
    keys: TICKET_TEST_KEYS.k1,
    issue: null,
    ticket:
      "t1.k1.other.1760000000.1760021600.play.file.kd7ay8r0ty1ry6q9y6eqvdc3y97t2wmf.s.j5701yqbmrsg2s1bjvhwj6x5a97t3qd5.jx76k6ga36g7tfhf9vtm1yahbs7t3ccv.6uYT-QZ1YBr0t_FwR6HTdgymAkk7ugcp0tXuvymU8tE",
    route: playRoute,
    now: 1760000001500,
    session: "live",
    admits: { ok: false, reason: "wrong_audience" },
  },
  {
    name: "a signed personal ticket 1 s over 6 h",
    keys: TICKET_TEST_KEYS.k1,
    issue: null,
    ticket:
      "t1.k1.media.1760000000.1760021601.play.file.kd7ay8r0ty1ry6q9y6eqvdc3y97t2wmf.s.j5701yqbmrsg2s1bjvhwj6x5a97t3qd5.jx76k6ga36g7tfhf9vtm1yahbs7t3ccv.BmTUHL3kFrbDQyfh8tPIBj9RctDB4hVamw4ySIV3emY",
    route: playRoute,
    now: 1760000001500,
    session: "live",
    admits: { ok: false, reason: "overlong" },
  },
  {
    name: "a signed personal ticket that expires as it is issued",
    keys: TICKET_TEST_KEYS.k1,
    issue: null,
    ticket:
      "t1.k1.media.1760000000.1760000000.play.file.kd7ay8r0ty1ry6q9y6eqvdc3y97t2wmf.s.j5701yqbmrsg2s1bjvhwj6x5a97t3qd5.jx76k6ga36g7tfhf9vtm1yahbs7t3ccv.ZVxHZMATMaDNXn4iEoBW-xHva_6cINxg4Ub3Wo78EmA",
    route: playRoute,
    now: 1759999999000,
    session: "live",
    admits: { ok: false, reason: "overlong" },
  },
  {
    name: "a signed shareable ticket off its bucket",
    keys: TICKET_TEST_KEYS.k1,
    issue: null,
    ticket:
      "t1.k1.media.1759968001.1761177601.image.artwork.9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08.a.diAoWlVLqLTykZ1CnVgZniIXyjS0Lobkbq-ruZP_0g8",
    route: artworkRoute,
    now: 1760000001500,
    session: "live",
    admits: { ok: false, reason: "overlong" },
  },
  {
    name: "a download ticket on a play route",
    keys: TICKET_TEST_KEYS.k1,
    issue: null,
    ticket:
      "t1.k1.media.1760000000.1760021600.download.file.kd7ay8r0ty1ry6q9y6eqvdc3y97t2wmf.s.j5701yqbmrsg2s1bjvhwj6x5a97t3qd5.jx76k6ga36g7tfhf9vtm1yahbs7t3ccv.QnCSlJIpDXNjeJrZqYzsHCh29vYjPrF59eUJSfCVDu8",
    route: playRoute,
    now: 1760000001500,
    session: "live",
    admits: { ok: false, reason: "wrong_purpose" },
  },
  {
    name: "a ticket for another file",
    keys: TICKET_TEST_KEYS.k1,
    issue: null,
    ticket:
      "t1.k1.media.1760000000.1760021600.play.file.kd7ay8r0ty1ry6q9y6eqvdc3y97t2wmf.s.j5701yqbmrsg2s1bjvhwj6x5a97t3qd5.jx76k6ga36g7tfhf9vtm1yahbs7t3ccv.fonybPBe6YpKNEd2U_-Ih0XeYvD2LjUny3thssRwYRk",
    route: {
      purposes: ["play"],
      resource: { kind: "file", id: "kd7ay8r0ty1ry6q9y6eqvdc3y97t2wmg" },
    },
    now: 1760000001500,
    session: "live",
    admits: { ok: false, reason: "wrong_resource" },
  },
  {
    name: "an artwork ticket on a file route with the same id",
    keys: TICKET_TEST_KEYS.k1,
    issue: null,
    ticket:
      "t1.k1.media.1759968000.1761177600.image.artwork.9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08.a.DR0XtbxV4JyhEbXDUdCOFXLVm8llhCpm7uRFS4VKmic",
    route: {
      purposes: ["image"],
      resource: {
        kind: "file",
        id: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
      },
    },
    now: 1760000001500,
    session: "live",
    admits: { ok: false, reason: "wrong_resource" },
  },
  {
    name: "a ticket presented 1 ms past the clock skew before it was issued",
    keys: TICKET_TEST_KEYS.k1,
    issue: null,
    ticket:
      "t1.k1.media.1760000000.1760021600.play.file.kd7ay8r0ty1ry6q9y6eqvdc3y97t2wmf.s.j5701yqbmrsg2s1bjvhwj6x5a97t3qd5.jx76k6ga36g7tfhf9vtm1yahbs7t3ccv.fonybPBe6YpKNEd2U_-Ih0XeYvD2LjUny3thssRwYRk",
    route: playRoute,
    now: 1759999939999,
    session: "live",
    admits: { ok: false, reason: "not_yet_valid" },
  },
  {
    name: "a ticket presented at its expiry",
    keys: TICKET_TEST_KEYS.k1,
    issue: null,
    ticket:
      "t1.k1.media.1760000000.1760021600.play.file.kd7ay8r0ty1ry6q9y6eqvdc3y97t2wmf.s.j5701yqbmrsg2s1bjvhwj6x5a97t3qd5.jx76k6ga36g7tfhf9vtm1yahbs7t3ccv.fonybPBe6YpKNEd2U_-Ih0XeYvD2LjUny3thssRwYRk",
    route: playRoute,
    now: 1760021600000,
    session: "live",
    admits: { ok: false, reason: "expired" },
  },
  {
    name: "an artwork ticket presented at its expiry",
    keys: TICKET_TEST_KEYS.k1,
    issue: null,
    ticket:
      "t1.k1.media.1759968000.1761177600.image.artwork.9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08.a.DR0XtbxV4JyhEbXDUdCOFXLVm8llhCpm7uRFS4VKmic",
    route: artworkRoute,
    now: 1761177600000,
    session: "live",
    admits: { ok: false, reason: "expired" },
  },
  {
    name: "a ticket whose session ended",
    keys: TICKET_TEST_KEYS.k1,
    issue: null,
    ticket:
      "t1.k1.media.1760000000.1760021600.play.file.kd7ay8r0ty1ry6q9y6eqvdc3y97t2wmf.s.j5701yqbmrsg2s1bjvhwj6x5a97t3qd5.jx76k6ga36g7tfhf9vtm1yahbs7t3ccv.fonybPBe6YpKNEd2U_-Ih0XeYvD2LjUny3thssRwYRk",
    route: playRoute,
    now: 1760000001500,
    session: "ended",
    admits: { ok: false, reason: "session_ended" },
  },
  {
    name: "a ticket whose session the server cannot read",
    keys: TICKET_TEST_KEYS.k1,
    issue: null,
    ticket:
      "t1.k1.media.1760000000.1760021600.play.file.kd7ay8r0ty1ry6q9y6eqvdc3y97t2wmf.s.j5701yqbmrsg2s1bjvhwj6x5a97t3qd5.jx76k6ga36g7tfhf9vtm1yahbs7t3ccv.fonybPBe6YpKNEd2U_-Ih0XeYvD2LjUny3thssRwYRk",
    route: playRoute,
    now: 1760000001500,
    session: "unavailable",
    admits: { ok: false, reason: "session_unavailable" },
  },
];
