import { createHash } from "node:crypto";

import { MediaFileId, type LibraryId } from "@media/contracts/ids";
import { MediaFileNotFound } from "@media/contracts/media-playback";
import { Context, Effect, Layer, Ref } from "effect";

import * as FileResolver from "../playback/file-resolver.ts";
import * as LibrarySink from "./library-sink.ts";

/** One stored file. */
export interface StoredFile {
  readonly fileId: MediaFileId;
  readonly folder: LibrarySink.LibraryFolder;
  readonly record: LibrarySink.ScannedFile;
  readonly missing: boolean;
}

/** Inspection of the in-memory store. */
export interface Interface {
  readonly files: (libraryId: LibraryId) => Effect.Effect<ReadonlyArray<StoredFile>>;
  readonly progress: (
    libraryId: LibraryId,
  ) => Effect.Effect<ReadonlyArray<LibrarySink.ScanProgress>>;
}

/** The in-memory library store. */
export class Service extends Context.Service<Service, Interface>()("@media/server/MemoryLibrary") {}

interface State {
  readonly files: ReadonlyMap<MediaFileId, StoredFile>;
  readonly progress: ReadonlyMap<LibraryId, ReadonlyArray<LibrarySink.ScanProgress>>;
}

/** A stable file ID derived from the library and the path inside its folder. */
export const fileIdOf = (libraryId: LibraryId, relativePath: string): MediaFileId =>
  MediaFileId.make(
    createHash("sha256")
      .update(`${libraryId}\u0000${relativePath}`)
      .digest("base64url")
      .slice(0, 22),
  );

const inFolder =
  (folder: LibrarySink.LibraryFolder) =>
  (file: StoredFile): boolean =>
    file.folder.libraryId === folder.libraryId && file.folder.root === folder.root;

/** A fresh, empty store providing `LibrarySink`, `FileResolver`, and this inspection service. */
export const layer: Layer.Layer<Service | LibrarySink.Service | FileResolver.Service> =
  Layer.effectContext(
    Effect.gen(function* () {
      const state = yield* Ref.make<State>({ files: new Map(), progress: new Map() });

      const updateFiles = (
        change: (files: Map<MediaFileId, StoredFile>) => void,
      ): Effect.Effect<void> =>
        Ref.update(state, (current) => {
          const files = new Map(current.files);
          change(files);

          return { ...current, files };
        });

      const sink = LibrarySink.Service.of({
        previousIndex: Effect.fn("MemoryLibrary.previousIndex")(function* (folder) {
          return [...(yield* Ref.get(state)).files.values()].flatMap((file) =>
            inFolder(folder)(file) && !file.missing
              ? [
                  {
                    relativePath: file.record.relativePath,
                    sizeBytes: file.record.sizeBytes,
                    modifiedAtMs: file.record.modifiedAtMs,
                    sidecarDigest: file.record.sidecarDigest,
                  },
                ]
              : [],
          );
        }),
        upsertBatch: Effect.fn("MemoryLibrary.upsertBatch")(function* (folder, records) {
          yield* updateFiles((files) => {
            for (const record of records) {
              const fileId = fileIdOf(folder.libraryId, record.relativePath);
              files.set(fileId, { fileId, folder, record, missing: false });
            }
          });
        }),
        markMissing: Effect.fn("MemoryLibrary.markMissing")(function* (folder, relativePaths) {
          yield* updateFiles((files) => {
            for (const relativePath of relativePaths) {
              const fileId = fileIdOf(folder.libraryId, relativePath);
              const stored = files.get(fileId);

              if (stored !== undefined) files.set(fileId, { ...stored, missing: true });
            }
          });
        }),
        reportProgress: Effect.fn("MemoryLibrary.reportProgress")(function* (folder, report) {
          yield* Ref.update(state, (current) => {
            const progress = new Map(current.progress);
            progress.set(folder.libraryId, [
              ...(current.progress.get(folder.libraryId) ?? []),
              report,
            ]);

            return { ...current, progress };
          });
        }),
      });

      const resolver = FileResolver.Service.of({
        resolve: Effect.fn("MemoryLibrary.resolve")(function* (fileId: MediaFileId) {
          const stored = (yield* Ref.get(state)).files.get(fileId);

          if (stored === undefined || stored.missing) {
            return yield* new MediaFileNotFound({ fileId });
          }

          const absolute = (relativePath: string) => `${stored.folder.root}/${relativePath}`;

          return {
            fileId,
            path: absolute(stored.record.relativePath),
            sizeBytes: stored.record.sizeBytes,
            modifiedAtMs: stored.record.modifiedAtMs,
            probe: stored.record.probe,
            subtitles: stored.record.subtitles.map((subtitle) => ({
              path: absolute(subtitle.path),
              format: subtitle.format,
              language: subtitle.language,
              title: subtitle.title,
              forced: subtitle.forced,
              hearingImpaired: subtitle.hearingImpaired,
              default: subtitle.default,
            })),
          } satisfies FileResolver.ResolvedMediaFile;
        }),
      });

      const inspection = Service.of({
        files: Effect.fn("MemoryLibrary.files")(function* (libraryId) {
          return [...(yield* Ref.get(state)).files.values()].filter(
            (file) => file.folder.libraryId === libraryId,
          );
        }),
        progress: Effect.fn("MemoryLibrary.progress")(function* (libraryId) {
          return (yield* Ref.get(state)).progress.get(libraryId) ?? [];
        }),
      });

      return Context.empty().pipe(
        Context.add(Service, inspection),
        Context.add(LibrarySink.Service, sink),
        Context.add(FileResolver.Service, resolver),
      );
    }),
  );
