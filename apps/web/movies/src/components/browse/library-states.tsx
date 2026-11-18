import type { TitleCard } from "@/lib/catalog";
import { buttonVariants } from "@media/ui/lib/button-variants";
import { CalmState } from "@media/ui/components/calm-state";
import { cn } from "@media/ui/lib/utils";
import { FolderPlusIcon, PlusIcon } from "lucide-react";

import { ACCOUNT_LIBRARIES } from "@/lib/account-links";
import { formatCount } from "@/lib/format";

import { HeroSkeleton, RowSkeleton } from "./skeletons";
import { TitlePosterCard } from "./title-cards";

const ARRIVING_SLOTS = 8;

/**
 * No movies library yet. Admins get the way to add one, on the account client, where libraries are
 * made.
 */
export function EmptyLibrary({ canAdd }: { readonly canAdd: boolean }) {
  return (
    <div className="flex min-h-[calc(100svh-var(--spacing-40))] items-center justify-center px-6 pb-17">
      <CalmState
        className="max-w-140 gap-7"
        visual={
          <div aria-hidden className="flex items-end gap-3">
            <span className="h-36 w-24 rounded-poster border-control border-dashed border-hairline" />
            <span className="flex h-45 w-30 items-center justify-center rounded-poster border-control border-dashed border-accent/70">
              <PlusIcon className="size-8 text-accent" strokeWidth={1.75} />
            </span>
            <span className="h-36 w-24 rounded-poster border-control border-dashed border-hairline" />
          </div>
        }
        title="No libraries yet"
        description={
          canAdd
            ? "Add a folder of movies or shows from this machine or your NAS."
            : "Titles appear here once an admin adds a library."
        }
        actions={
          canAdd ? (
            <a href={ACCOUNT_LIBRARIES} className={cn(buttonVariants({ size: "lg" }), "pr-6 pl-5")}>
              <FolderPlusIcon strokeWidth={1.75} aria-hidden />
              Add library
            </a>
          ) : undefined
        }
      />
    </div>
  );
}

/** A library with no titles this person can see, and no scan running. */
export function NothingToWatch() {
  return (
    <div className="flex min-h-[calc(100svh-var(--spacing-40))] items-center justify-center px-6 pb-17">
      <CalmState title="Nothing to watch yet" />
    </div>
  );
}

/**
 * The first scan is still running: a placeholder billboard, the titles that arrived so far, and
 * placeholders for the rest.
 */
export function ScanningLibrary({ arrived }: { readonly arrived: ReadonlyArray<TitleCard> }) {
  return (
    <div className="flex flex-col gap-10 pt-4 md:pt-17">
      <HeroSkeleton inset />
      <section aria-label="Recently added" className="flex flex-col gap-3.5 overflow-hidden">
        <div className="flex items-baseline gap-2.5 px-5 md:px-16">
          <h2 className="text-heading/heading font-bold tracking-tight text-text">
            Recently added
          </h2>
          {arrived.length === 0 ? null : (
            <p className="font-mono text-caption/caption text-text-muted">
              +{formatCount(arrived.length)} so far
            </p>
          )}
        </div>
        <div className="flex gap-4 px-4 md:px-16">
          {arrived.slice(0, ARRIVING_SLOTS).map((title) => (
            <TitlePosterCard key={title.id} title={title} />
          ))}
          {Array.from({ length: Math.max(0, ARRIVING_SLOTS - arrived.length) }, (_, index) => (
            <span
              key={index}
              aria-hidden
              className="aspect-2/3 w-42 shrink-0 rounded-poster bg-text/5"
            />
          ))}
        </div>
      </section>
      <RowSkeleton kind="landscape" />
    </div>
  );
}
