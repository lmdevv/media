import type { DownloadKind, downloadKinds } from "../../commands/access";
import type { DownloadQuality } from "../../commands/settings";
import type { Doc, Id } from "../_generated/dataModel";
import type { DatabaseReader } from "../_generated/server";
import { fileSource } from "../movies/items";
import { trackSource } from "../music/items";
import type { ContentFacts } from "./permissions/policy";

type Entry<K extends DownloadKind> = (typeof downloadKinds)[K];

/** An item of kind `K` as a download names it. */
export interface ItemOf<K extends DownloadKind> {
  readonly kind: K;
  readonly id: Id<Entry<K>["table"]>;
}

/**
 * What a domain says about one of its items for downloads, read live in the caller's call. It is
 * how a domain packages its own files behind one interface (ADR 0019): the core decides who may
 * keep the item and how much space it takes, and the domain says what the item is.
 */
export interface DownloadSource<K extends DownloadKind = DownloadKind> {
  /** The item's library, for `can`. */
  readonly library: Id<"libraries">;
  /** The facts a kid's restrictions read, as playing the item would see them. */
  readonly facts: ContentFacts;
  /** What a download ticket for the item names: the file or track its domain serves. */
  readonly resource: { readonly kind: Entry<K>["serves"]; readonly id: string };
  /**
   * Opaque, and changes whenever the bytes a device should hold change: another file for the
   * item, or a new size or change time. A device holding another revision fetches it again.
   */
  readonly revision: string;
  /** The domain's estimate of the bytes it packages for a device at `quality`; the core rounds it up. */
  readonly bytes: (quality: DownloadQuality) => number;
  /** A name to show for the item in lists. */
  readonly label: string;
}

/** Reads a library at most once per call, however many items name it. */
export type LibraryReader = (libraryId: Id<"libraries">) => Promise<Doc<"libraries"> | null>;

/** Reads one item of kind `K`, its library through `libraryOf`; null when either is gone. */
export type SourceLoader<K extends DownloadKind> = (
  db: DatabaseReader,
  id: Id<Entry<K>["table"]>,
  libraryOf: LibraryReader,
) => Promise<DownloadSource<K> | null>;

/** How one download kind is described: a loader, and the most documents it reads. */
interface Source<K extends DownloadKind> {
  readonly reads: number;
  readonly load: SourceLoader<K>;
}

type SourceLoaders = { readonly [K in DownloadKind]: Source<K> };

const loaders: SourceLoaders = {
  file: { reads: 3, load: fileSource },
  track: { reads: 2, load: trackSource },
};

/** The most documents describing one item reads. */
export const SOURCE_READS = Math.max(...Object.values(loaders).map((source) => source.reads));

/** The item as its domain describes it now, or null when it is gone. */
export const sourceOf = <K extends DownloadKind>(
  db: DatabaseReader,
  item: ItemOf<K>,
  libraryOf: LibraryReader,
): Promise<DownloadSource<K> | null> => loaders[item.kind].load(db, item.id, libraryOf);
