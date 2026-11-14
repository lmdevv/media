import type { PlatformSdk } from "@media/sdk/promise";
import { Match } from "effect";
import { toast } from "sonner";

import { toastFailure } from "@/lib/action";
import { asAlbumId, asArtistId, asPlaylistId, asTrackId } from "@/lib/models";
import { useMusic } from "@/lib/platform";

/** What a link points at: an album, artist, playlist, or song by its ID. */
export interface LinkTarget {
  readonly kind: "album" | "artist" | "playlist" | "track";
  readonly id: string;
}

interface ResolvedLink {
  readonly title: string;
  readonly url: string;
}

const pageUrl = (path: string): string =>
  new URL(`${import.meta.env.BASE_URL}${path}`, window.location.origin).toString();

/**
 * The link's title and address, read from the record it names, which checks that you can open it,
 * as old music's `links.get` did: a song opens its album with the song highlighted.
 */
const linkFor = (music: PlatformSdk["music"], target: LinkTarget): Promise<ResolvedLink> =>
  Match.value(target.kind).pipe(
    Match.when("album", async () => {
      const { album } = await music.albums.get({ albumId: asAlbumId(target.id) });

      return { title: album.title, url: pageUrl(`albums/${album.id}`) };
    }),
    Match.when("artist", async () => {
      const { artist } = await music.artists.get({ artistId: asArtistId(target.id) });

      return { title: artist.name, url: pageUrl(`artists/${artist.id}`) };
    }),
    Match.when("playlist", async () => {
      const playlist = await music.playlists.get({ playlistId: asPlaylistId(target.id) });

      return { title: playlist.name, url: pageUrl(`playlists/${playlist.id}`) };
    }),
    Match.when("track", async () => {
      const track = await music.tracks.get({ trackId: asTrackId(target.id) });

      return { title: track.title, url: pageUrl(`albums/${track.albumId}?track=${track.id}`) };
    }),
    Match.exhaustive,
  );

const asText = async (pending: Promise<ResolvedLink>): Promise<Blob> =>
  new Blob([(await pending).url], { type: "text/plain" });

/**
 * Writes the link to the clipboard. The clipboard gets a promise of it at once, while the click
 * still counts as a user gesture: Safari refuses a write that starts only after the server
 * answers. Browsers without `ClipboardItem` write the text once it arrives.
 */
const writeToClipboard = async (pending: Promise<ResolvedLink>): Promise<void> => {
  if ("ClipboardItem" in window) {
    await navigator.clipboard.write([new ClipboardItem({ "text/plain": asText(pending) })]);

    return;
  }

  await navigator.clipboard.writeText((await pending).url);
};

/**
 * Copies a link to an album, artist, playlist, or song. The server checks that you can open it
 * and builds the path (a song opens its album with the song highlighted); the link uses this
 * page's address, so it works for anyone who reaches the server the same way. Browsers allow the
 * clipboard only on secure pages, so elsewhere (plain http on a home network) the toast shows the
 * link to copy by hand.
 */
export const useCopyLink = (): ((target: LinkTarget) => void) => {
  const music = useMusic();

  const copy = async (target: LinkTarget): Promise<void> => {
    const pending = linkFor(music, target);

    if (!window.isSecureContext) {
      const { title, url } = await pending;

      toast(`Link to ${title}`, { description: url });

      return;
    }

    try {
      await writeToClipboard(pending);
    } catch (cause) {
      await pending;
      throw cause;
    }

    toast.success("Link copied", { description: (await pending).url });
  };

  return (target) => {
    copy(target).catch(toastFailure);
  };
};
