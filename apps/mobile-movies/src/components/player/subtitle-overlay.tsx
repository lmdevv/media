import { useEffect, useState } from "react";
import { View } from "react-native";

import { Text } from "@/components/ui/text";
import { cuesAt, parseWebVtt } from "@/lib/player/webvtt";
import type { Cue } from "@/lib/player/webvtt";

/** Props for `SubtitleOverlay`. */
export interface SubtitleOverlayProps {
  /** The WebVTT URL of the text track shown, or null for none. */
  readonly url: string | null;
  readonly positionSeconds: number;
  readonly delayMs: number;
  /** The controls are up, so the cues sit above the scrubber. */
  readonly raised: boolean;
}

const useCues = (url: string | null): ReadonlyArray<Cue> => {
  const [loaded, setLoaded] = useState<{
    readonly url: string;
    readonly cues: ReadonlyArray<Cue>;
  } | null>(null);

  useEffect(() => {
    if (url === null) return undefined;

    const controller = new AbortController();

    const load = async (): Promise<void> => {
      try {
        const response = await fetch(url, { signal: controller.signal });
        const text = response.ok ? await response.text() : "";

        setLoaded({ url, cues: parseWebVtt(text) });
      } catch {
        if (!controller.signal.aborted) setLoaded({ url, cues: [] });
      }
    };

    void load();

    return () => {
      controller.abort();
    };
  }, [url]);

  return loaded !== null && loaded.url === url ? loaded.cues : [];
};

/** The subtitles showing now. */
export function SubtitleOverlay({ url, positionSeconds, delayMs, raised }: SubtitleOverlayProps) {
  const cues = useCues(url);
  const showing = cuesAt(cues, positionSeconds, delayMs);

  if (showing.length === 0) return null;

  return (
    <View
      pointerEvents="none"
      className={`absolute right-0 left-0 items-center px-24 ${raised ? "bottom-36" : "bottom-8"}`}
    >
      <View className="items-center rounded-control bg-scrim px-2 py-1">
        {showing.flatMap((cue) =>
          cue.lines.map((spans, line) => (
            <Text
              key={`${String(cue.start)}-${String(line)}`}
              variant="bodyStrong"
              tone="onMedia"
              className="text-center"
            >
              {spans.map((span, index) => (
                <Text
                  key={String(index)}
                  variant="bodyStrong"
                  tone="onMedia"
                  className={span.italic ? "italic" : ""}
                >
                  {span.text}
                </Text>
              ))}
            </Text>
          )),
        )}
      </View>
    </View>
  );
}
