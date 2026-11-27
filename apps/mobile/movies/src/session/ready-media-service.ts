import { createServer } from "node:http";

import { DownloadReady } from "@media/contracts/media-playback";
import { Predicate, Schema } from "effect";

const encodeReady = Schema.encodeSync(Schema.fromJsonString(DownloadReady));

/** A media service on this computer, at `url`, that answers every download as ready to fetch. */
export interface ReadyMediaService {
  readonly url: string;
  readonly close: () => void;
}

/** Starts a `ReadyMediaService` on a free port. */
export const readyMediaService = async (): Promise<ReadyMediaService> => {
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        encodeReady(
          DownloadReady.make({
            mode: "remux",
            url: "http://127.0.0.1:9/video.mp4",
            sizeBytes: 900_000,
            container: "mp4",
            durationSeconds: 600,
            video: { codec: "h264", width: 1280, height: 720, dynamicRange: "sdr" },
            subtitles: [],
            expiresAt: Date.now() + 3_600_000,
          }),
        ),
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();

  if (address === null || Predicate.isString(address)) throw new Error("The server is not on TCP");

  return { url: `http://127.0.0.1:${String(address.port)}`, close: () => server.close() };
};
