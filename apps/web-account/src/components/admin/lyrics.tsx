import { usePlatform, usePlatformQuery } from "@media/sdk/react";
import { Switch } from "@media/ui/components/switch";
import { useId } from "react";

import { useActions } from "./action";
import { Section } from "./parts";

/**
 * Music's switch for LRCLIB lookups, old music's "Look up lyrics online" from its library
 * settings: it saves as it is flipped. Only owners and admins may read or change it, so it shows
 * only once the server answered.
 */
export function RemoteLyricsSetting() {
  const platform = usePlatform();
  const status = usePlatformQuery(platform.music.lyrics.status);
  const actions = useActions<"save">();

  if (status.status !== "success") return null;

  return (
    <RemoteLyricsView
      remote={status.data.remote}
      saving={actions.running === "save"}
      onChange={(remote) =>
        void actions.run(
          "save",
          () => platform.music.lyrics.configure({ remote }),
          remote ? "Lyrics lookups are on" : "Lyrics lookups are off",
        )
      }
    />
  );
}

/** Lyrics lookups on LRCLIB on or off, saved as the switch flips. */
export function RemoteLyricsView({
  remote,
  saving,
  onChange,
}: {
  readonly remote: boolean;
  readonly saving: boolean;
  readonly onChange: (remote: boolean) => void;
}) {
  const switchId = useId();
  const hintId = useId();

  return (
    <Section title="Lyrics">
      <div className="flex items-center justify-between gap-4 md:max-w-120">
        <div className="flex flex-col gap-0.5">
          <label htmlFor={switchId} className="font-sans text-label/label text-text">
            Look up lyrics online
          </label>
          <span id={hintId} className="font-sans text-label/4 text-text-muted">
            Sends the title, artist, album, and length of songs without lyrics to LRCLIB.
          </span>
        </div>
        <Switch
          id={switchId}
          aria-describedby={hintId}
          checked={remote}
          disabled={saving}
          onCheckedChange={onChange}
        />
      </div>
    </Section>
  );
}
