import { presentationOf } from "@/lib/now-playing-layout";
import { DEVICE_FAMILY } from "@/lib/this-device";

/** How Now Playing is presented on this device, the same whatever the window does while it is up. */
export const NOW_PLAYING_PRESENTATION = presentationOf(DEVICE_FAMILY);
