/** How Now Playing is presented here, for the screen and the two stacks that present it. */
import { presentationOf } from "@/lib/now-playing-layout";
import { DEVICE_FAMILY } from "@/lib/this-device";

/** How Now Playing is presented on this device, the same whatever the window does while it is up. */
export const NOW_PLAYING_PRESENTATION = presentationOf(DEVICE_FAMILY);
