/**
 * Starts and at once pauses an empty audio element. Called inside a user gesture, this lifts iOS
 * Safari's per-element "play only from a gesture" rule. With no source nothing plays; the play
 * promise rejects (no source, or interrupted by the pause) and that is expected.
 */
export const primeInGesture = (element: Pick<HTMLAudioElement, "play" | "pause">): void => {
  element.play().catch(() => {});
  element.pause();
};
