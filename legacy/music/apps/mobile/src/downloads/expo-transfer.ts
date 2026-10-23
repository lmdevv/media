/**
 * HTTP for downloads on the iPhone. `HEAD` goes through `fetch`; a body goes through an
 * expo-file-system download task, which writes it to a temporary file and moves it into place
 * only once it is whole, so a broken transfer leaves no partial file behind. The task hides the
 * response's status, except in the message of the error it fails with.
 */
import { DownloadResult } from "@music/sdk/downloads";
import type { Transfer } from "@music/sdk/downloads";
import { File } from "expo-file-system";

/** How expo-file-system reports an error status: "…server returned HTTP 403". */
const HTTP_STATUS = /HTTP (\d{3})/u;

export const expoTransfer: Transfer = {
  head: (url, signal) => fetch(url, { method: "HEAD", signal }),
  download: async ({ url, destination, signal }) => {
    const file = new File(destination);

    try {
      if (file.exists) file.delete();
      const task = File.createDownloadTask(url, file, { signal });
      const written = await task.downloadAsync();

      return written === null
        ? DownloadResult.Broken({ message: "The download paused" })
        : DownloadResult.Written({ bytes: written.size });
    } catch (error) {
      const message = error instanceof Error ? error.message : "The download failed";
      const status = HTTP_STATUS.exec(message)?.[1];

      return status === undefined
        ? DownloadResult.Broken({ message })
        : DownloadResult.Refused({ status: Number(status) });
    }
  },
};
