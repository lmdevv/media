import { ConfigProvider, Layer } from "effect";

import * as MediaConfig from "../media-config.ts";

/**
 * `MediaConfig` decoded from an environment record, with defaults for the required names.
 * `overrides` replace defaults; pass `DATA_DIR`, `TRANSCODE_DIR`, and `LIBRARY_ROOTS` for tests
 * that touch the disk.
 */
export const testConfigLayer = (
  overrides: Readonly<Record<string, string>>,
): Layer.Layer<MediaConfig.Service> =>
  MediaConfig.layer.pipe(
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromEnv({
          env: {
            MEDIA_BASE_URL: "http://127.0.0.1:4300",
            LIBRARY_ROOTS: "/nonexistent",
            DATA_DIR: "/nonexistent/data",
            TRANSCODE_DIR: "/nonexistent/transcode",
            HARDWARE_ACCELERATION: "none",
            ...overrides,
          },
        }),
      ),
    ),
    Layer.orDie,
  );
