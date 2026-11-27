import {
  MEDIA_ROUTES,
  NegotiateRequest,
  NegotiateResponse,
  SeekRequest,
  SeekResponse,
  TranscodeCapacityReached,
  UnsupportedPlayback,
} from "@media/contracts/media-playback";
import type { PlaybackMode } from "@media/contracts/models/playback";
import { EpochMillis } from "@media/contracts/units";
import type { Page, Route } from "@playwright/test";
import { Option, Schema } from "effect";

// The answer's JSON form, as the SDK reads it (an absent burned-in subtitle arrives as null).
const decodeStream = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.toCodecJson(NegotiateResponse)),
);

/**
 * A stream the page negotiated: its mode, its id when it is HLS, the picture subtitle burned into
 * it, and the height of the video it delivers.
 */
export interface NegotiatedStream {
  readonly mode: PlaybackMode;
  readonly streamId: string | undefined;
  readonly burnedInSubtitle: string | undefined;
  readonly height: number;
}

/** Records every stream the page negotiates, in order. */
export const recordStreams = (page: Page): ReadonlyArray<NegotiatedStream> => {
  const streams: Array<NegotiatedStream> = [];

  page.on("response", (response) => {
    if (!response.url().endsWith(MEDIA_ROUTES.negotiate) || !response.ok()) return;

    void response.text().then(
      (body) =>
        Option.map(decodeStream(body), ({ mode, streamId, burnedInSubtitle, video }) =>
          streams.push({ mode, streamId, burnedInSubtitle, height: video.height }),
        ),
      () => Option.none(),
    );
  });

  return streams;
};

const negotiateRequest = Schema.toCodecJson(NegotiateRequest);

/**
 * A negotiation the page sent: the video codecs it listed, where it asked the stream to start,
 * and the mode and video codec of the stream it was answered, once answered.
 */
export interface AskedStream {
  readonly codecs: ReadonlyArray<string>;
  readonly startSeconds: number | undefined;
  readonly answered:
    | { readonly mode: PlaybackMode; readonly codec: string; readonly streamId: string | undefined }
    | undefined;
}

/**
 * Sends the page's first negotiation on as a device that plays HEVC alone would ask, so a media
 * service on the CPU encodes HEVC for it, and every later one as the page sent it, until the route
 * is removed; records each with the codecs the page itself listed. The answer to the second, which
 * a failed HEVC stream sends without HEVC, reaches the page only once `late` settles.
 */
export const askForHevcFirst = async (
  page: Page,
  late: Promise<void> = Promise.resolve(),
): Promise<ReadonlyArray<AskedStream>> => {
  const asked: Array<AskedStream> = [];

  await page.route(`**${MEDIA_ROUTES.negotiate}`, async (route) => {
    const request = Schema.decodeUnknownSync(negotiateRequest)(route.request().postDataJSON());
    const listed = request.capabilities.videoCodecs;

    const sent =
      asked.length === 0
        ? {
            ...request,
            capabilities: {
              ...request.capabilities,
              videoCodecs: listed.filter((support) => support.codec === "hevc"),
            },
          }
        : request;

    const index = asked.length;

    const codecs = listed.map((support) => support.codec);
    const { startSeconds } = request;

    asked.push({ codecs, startSeconds, answered: undefined });

    const response = await route.fetch({
      postData: JSON.stringify(Schema.encodeSync(negotiateRequest)(sent)),
    });

    if (index === 1) await late;

    asked[index] = {
      codecs,
      startSeconds,
      answered: Option.getOrUndefined(
        Option.map(decodeStream(await response.text()), ({ mode, video, streamId }) => ({
          mode,
          codec: video.codec,
          streamId,
        })),
      ),
    };
    await route.fulfill({ response }).catch(() => undefined);
  });

  return asked;
};

const capacityReached = Schema.encodeSync(
  Schema.fromJsonString(Schema.toCodecJson(TranscodeCapacityReached)),
)(new TranscodeCapacityReached({ limit: 1 }));

/**
 * Answers the page's negotiations that ask for a quality cap as a media service with every
 * transcode slot taken would, until the route is removed; the first such answer waits
 * `delayFirstMs`, so a later choice can overtake it.
 */
export const refuseQualityCaps = async (page: Page, delayFirstMs = 0): Promise<void> => {
  let delay = delayFirstMs;

  await page.route(`**${MEDIA_ROUTES.negotiate}`, async (route) => {
    if (!(route.request().postData() ?? "").includes('"quality"')) return route.continue();

    const wait = delay;

    delay = 0;

    if (wait > 0) await page.waitForTimeout(wait);

    return route
      .fulfill({ status: 503, contentType: "application/json", body: capacityReached })
      .catch(() => undefined);
  });
};

const seekAnswer = Schema.toCodecJson(SeekResponse);

const seekRequest = Schema.decodeUnknownSync(Schema.toCodecJson(SeekRequest));

/** A seek the page asked for, whose answer waits until `release`. */
interface HeldSeek {
  /** Where the seek asked the stream to go, in seconds. */
  readonly seconds: number;
  readonly release: () => void;
}

/** The seeks `markSeekAnswers` holds, and how to remove its route. */
export interface MarkedSeeks {
  readonly held: ReadonlyArray<HeldSeek>;
  /** From now on, answers go back as soon as they come. */
  readonly letGo: () => void;
  readonly remove: () => Promise<void>;
}

/**
 * Sends each seek the page asks for on to the media server at once, and answers it with two
 * changes added that read the same and name the generation it moved to (`gen-2`), so stream info
 * shows which generation it describes. Answers wait in `held` until released or `letGo`.
 */
export const markSeekAnswers = async (page: Page): Promise<MarkedSeeks> => {
  const held: Array<HeldSeek> = [];
  let holding = true;

  const mark = async (route: Route) => {
    const response = await route.fetch();
    const moved = Schema.decodeUnknownSync(seekAnswer)(await response.json());

    if (holding) {
      const { positionSeconds } = seekRequest(route.request().postDataJSON());

      await new Promise<void>((release) => {
        held.push({ seconds: positionSeconds, release });
      });
    }

    const change = {
      at: EpochMillis.make(Date.now()),
      generation: moved.generation,
      cause: "source",
      excluded: [`gen-${String(moved.generation)}`],
      reason: "file-only" as const,
    };

    await route.fulfill({
      response,
      json: Schema.encodeSync(seekAnswer)({
        ...moved,
        transcode: { ...moved.transcode, changes: [change, change] },
      }),
    });
  };

  await page.route(`**${MEDIA_ROUTES.seek}`, mark);

  return {
    held,
    letGo: () => {
      holding = false;
    },
    remove: () => page.unroute(`**${MEDIA_ROUTES.seek}`, mark),
  };
};

const unsupported = Schema.encodeSync(
  Schema.fromJsonString(Schema.toCodecJson(UnsupportedPlayback)),
)(new UnsupportedPlayback({ reason: "hdr-tone-mapping-requires-hardware" }));

/**
 * Answers the page's next negotiation as a media service that cannot stream the file to this
 * browser at all would; later negotiations reach the real service.
 */
export const refuseNextNegotiation = async (page: Page): Promise<void> => {
  let refused = false;

  await page.route(`**${MEDIA_ROUTES.negotiate}`, async (route) => {
    if (refused || route.request().method() !== "POST") return route.continue();

    refused = true;

    return route.fulfill({ status: 422, contentType: "application/json", body: unsupported });
  });
};
