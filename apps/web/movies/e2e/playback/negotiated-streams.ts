import {
  MEDIA_ROUTES,
  NegotiateResponse,
  TranscodeCapacityReached,
  UnsupportedPlayback,
} from "@media/contracts/media-playback";
import type { PlaybackMode } from "@media/contracts/models/playback";
import type { Page } from "@playwright/test";
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
