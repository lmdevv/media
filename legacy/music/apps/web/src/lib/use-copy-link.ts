import type { LinkKind } from "@music/commands/models";
import { useReadOnce } from "@music/sdk/react";
import { toast } from "sonner";

import { toastFailure } from "@/lib/action";

/** What a link points at: an album, artist, playlist, or song by its ID. */
export interface LinkTarget {
  readonly kind: LinkKind;
  readonly id: string;
}

/** A link's title and full URL, on this page's address. */
interface ResolvedLink {
  readonly title: string;
  readonly url: string;
}

const linkFor = async (
  read: ReturnType<typeof useReadOnce<"links.get">>,
  target: LinkTarget,
): Promise<ResolvedLink> => {
  const link = await read({ kind: target.kind, id: target.id });

  return { title: link.title, url: new URL(link.path, window.location.origin).toString() };
};

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
  const read = useReadOnce("links.get");

  const copy = async (target: LinkTarget): Promise<void> => {
    const pending = linkFor(read, target);

    if (!window.isSecureContext) {
      const { title, url } = await pending;

      toast(`Link to ${title}`, { description: url });

      return;
    }

    try {
      await writeToClipboard(pending);
    } catch (cause) {
      // A link the server refused fails the write too; its reason says more.
      await pending;
      throw cause;
    }

    toast.success("Link copied", { description: (await pending).url });
  };

  return (target) => {
    copy(target).catch(toastFailure);
  };
};
