/** Test support: HTTP over Node's fetch, writing bodies to files, as a desktop downloader would. */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { DownloadResult } from "./finished-file";
import type { Transfer } from "./finished-file";

/** A `Transfer` over Node. */
export const nodeTransfer: Transfer = {
  head: (url, signal) => fetch(url, { method: "HEAD", signal }),
  download: async ({ url, destination, signal }) => {
    try {
      const response = await fetch(url, { signal });

      if (!response.ok) {
        await response.body?.cancel();

        return DownloadResult.Refused({ status: response.status });
      }

      const body = Buffer.from(await response.arrayBuffer());
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, body);

      return DownloadResult.Written({ bytes: body.length });
    } catch (error) {
      return DownloadResult.Broken({ message: error instanceof Error ? error.message : "Failed" });
    }
  },
};
