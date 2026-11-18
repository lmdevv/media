import { useCallback, useEffect, useState } from "react";

/** Picture in picture as the player uses it. */
export interface PictureInPicture {
  readonly active: boolean;
  readonly toggle: () => void;
}

const PIP = "picture-in-picture";

const standard = (video: HTMLVideoElement): boolean =>
  document.pictureInPictureEnabled && !video.disablePictureInPicture;

const webkit = (video: HTMLVideoElement): boolean =>
  video.webkitSupportsPresentationMode?.(PIP) === true &&
  video.webkitSetPresentationMode !== undefined;

/** Picture in picture for `video`, or null where the browser offers none. */
export const usePictureInPicture = (video: HTMLVideoElement | null): PictureInPicture | null => {
  const [active, setActive] = useState(false);
  const supported = video !== null && (standard(video) || webkit(video));

  useEffect(() => {
    if (video === null || !supported) return undefined;

    const onChange = (): void =>
      setActive(document.pictureInPictureElement === video || video.webkitPresentationMode === PIP);

    video.addEventListener("enterpictureinpicture", onChange);
    video.addEventListener("leavepictureinpicture", onChange);
    video.addEventListener("webkitpresentationmodechanged", onChange);

    return () => {
      video.removeEventListener("enterpictureinpicture", onChange);
      video.removeEventListener("leavepictureinpicture", onChange);
      video.removeEventListener("webkitpresentationmodechanged", onChange);
    };
  }, [video, supported]);

  const toggle = useCallback(() => {
    if (video === null) return;

    if (standard(video)) {
      void (
        document.pictureInPictureElement === video
          ? document.exitPictureInPicture()
          : video.requestPictureInPicture()
      ).catch(() => undefined);

      return;
    }

    video.webkitSetPresentationMode?.(video.webkitPresentationMode === PIP ? "inline" : PIP);
  }, [video]);

  return supported ? { active, toggle } : null;
};
