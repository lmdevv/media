import { v } from "convex/values";

import { foldersOf, isInside } from "../core/folders";
import { serverQuery } from "../core/lib/serverFacing";
import { externalSubtitle, probe } from "./validators";

/**
 * What the server needs to stream a file: its path, its library's folders now, what ffprobe saw
 * in it, and the subtitle files beside it. Null for an id that names no file, and for a file that
 * is missing, whose title is gone or being purged, whose library is gone, or that no folder of its
 * library holds now (a removed folder's purge has yet to reach it). So `missing` is always false;
 * it stays for the shape old movies answered.
 */
export const resolveFile = serverQuery({
  args: { fileId: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      fileId: v.id("mediaFiles"),
      libraryId: v.id("libraries"),
      path: v.string(),
      roots: v.array(v.string()),
      probe,
      externalSubtitles: v.array(externalSubtitle),
      missing: v.boolean(),
    }),
  ),
  handler: async (ctx, { fileId }) => {
    const id = ctx.db.normalizeId("mediaFiles", fileId);
    const file = id === null ? null : await ctx.db.get(id);

    if (file === null || file.missing) return null;

    const [title, library] = await Promise.all([
      ctx.db.get(file.titleId),
      ctx.db.get(file.libraryId),
    ]);

    if (title === null || title.purging === true || library === null) return null;

    const roots = await foldersOf(ctx.db, library._id);

    if (!roots.some((root) => isInside(file.path, root))) return null;

    return {
      fileId: file._id,
      libraryId: library._id,
      path: file.path,
      roots: [...roots],
      probe: file.probe,
      externalSubtitles: file.externalSubtitles,
      missing: file.missing,
    };
  },
});
