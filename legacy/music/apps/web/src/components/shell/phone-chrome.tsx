import { usePlayer } from "@music/player/react";
import { cn } from "@music/ui/lib/utils";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import type { LinkProps } from "@tanstack/react-router";
import { ListMusicIcon, SearchIcon, XIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Artwork } from "@/components/library/artwork";
import { deviceIcon, perform, useIsRemote } from "@/components/player/controls";

import { useUi } from "./ui-state";

/** The frosted capsule surface Paper draws for phone bars; code adds the blur. */
export const glassClassName =
  "border-hairline border-text/10 bg-surface-raised/78 shadow-glass backdrop-blur-xl backdrop-saturate-150";

function HomeGlyph({ filled }: { readonly filled: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className="size-6">
      <path
        d="M3 10.2 12 3l9 7.2V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"
        fill={filled ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth={filled ? 0 : 1.8}
        strokeLinejoin="round"
      />
    </svg>
  );
}

function LibraryGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-6"
    >
      <rect x="3" y="3" width="5" height="18" rx="1" />
      <rect x="10" y="3" width="5" height="18" rx="1" />
      <path d="m17.5 4.5 3.5 15" />
    </svg>
  );
}

/** The iOS-style pause glyph: two rounded bars. */
export function PhonePauseGlyph({ className }: { readonly className?: string }) {
  return (
    <svg viewBox="0 0 40 44" aria-hidden fill="currentColor" className={className}>
      <rect x="6" y="4" width="10" height="36" rx="2" />
      <rect x="24" y="4" width="10" height="36" rx="2" />
    </svg>
  );
}

/** The iOS-style play glyph. */
export function PhonePlayGlyph({ className }: { readonly className?: string }) {
  return (
    <svg viewBox="0 0 40 44" aria-hidden fill="currentColor" className={className}>
      <path d="M8 5.5v33a2 2 0 0 0 3 1.7l26-16.5a2 2 0 0 0 0-3.4L11 3.8a2 2 0 0 0-3 1.7Z" />
    </svg>
  );
}

/** The iOS-style skip glyphs: two triangles pointing forward or back. */
export function PhoneSkipGlyph({
  direction,
  className,
}: {
  readonly direction: "previous" | "next";
  readonly className?: string;
}) {
  return (
    <svg viewBox="0 0 44 30" aria-hidden fill="currentColor" className={className}>
      {direction === "next" ? (
        <>
          <path d="M3 3 L21 15 L3 27 Z" />
          <path d="M23 3 L41 15 L23 27 Z" />
        </>
      ) : (
        <>
          <path d="M21 3 L3 15 L21 27 Z" />
          <path d="M41 3 L23 15 L41 27 Z" />
        </>
      )}
    </svg>
  );
}

function MiniPlayer() {
  const player = usePlayer();
  const remote = useIsRemote();
  const { setNowPlaying } = useUi();
  const track = player.track;

  if (track === null) return null;

  const playing = player.status === "playing";

  // Another device plays: say where, in the accent like the desktop remote banner.
  const device =
    remote && player.activeDevice !== null
      ? { name: player.activeDevice.name, Icon: deviceIcon(player.activeDevice.kind) }
      : null;

  return (
    <div
      className={cn(
        "flex h-row-touch shrink-0 items-center gap-3 rounded-full pr-4.5 pl-2",
        glassClassName,
      )}
    >
      <button
        type="button"
        onClick={() => setNowPlaying("player")}
        aria-label={
          device === null
            ? `Open Now Playing: ${track.title}`
            : `Open Now Playing: ${track.title}, playing on ${device.name}`
        }
        className="flex min-w-0 grow items-center gap-3 text-left outline-none"
      >
        <Artwork url={track.artUrl} seed={track.albumId} className="size-row rounded-md" />
        <span className="flex min-w-0 grow flex-col">
          <span className="truncate font-sans text-phone-subhead leading-5 font-medium text-text">
            {track.title}
            {device === null ? null : (
              <span className="font-normal text-text-muted"> · {track.artist}</span>
            )}
          </span>
          {device === null ? (
            <span className="truncate font-sans text-sm leading-4.25 text-text-muted">
              {track.artist}
            </span>
          ) : (
            <span className="flex min-w-0 items-center gap-1 font-sans text-sm leading-4.25 font-medium text-accent">
              <device.Icon aria-hidden className="size-3.5 shrink-0" />
              <span className="truncate">Playing on {device.name}</span>
            </span>
          )}
        </span>
      </button>
      <button
        type="button"
        aria-label={playing ? "Pause" : "Play"}
        onClick={() => perform(player.togglePlay())}
        className="flex size-9 items-center justify-center text-text"
      >
        {playing ? (
          <PhonePauseGlyph className="h-5.5 w-5" />
        ) : (
          <PhonePlayGlyph className="h-5.5 w-5" />
        )}
      </button>
      <button
        type="button"
        aria-label="Next"
        onClick={() => perform(player.next())}
        className="flex size-9 items-center justify-center text-text"
      >
        <PhoneSkipGlyph direction="next" className="h-4.5 w-6.5" />
      </button>
    </div>
  );
}

function Tab({
  to,
  label,
  icon,
  active,
}: {
  readonly to: NonNullable<LinkProps["to"]>;
  readonly label: string;
  readonly icon: ReactNode;
  readonly active: boolean;
}) {
  return (
    <Link
      to={to}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex h-13.5 grow basis-0 flex-col items-center justify-center gap-0.5 rounded-full outline-none",
        active ? "bg-text/8 text-accent" : "text-text",
      )}
    >
      {icon}
      <span
        className={cn("font-sans text-3xs leading-3", active ? "font-semibold" : "font-medium")}
      >
        {label}
      </span>
    </Link>
  );
}

/** The search screen exists to type into its field, so the field takes focus on arrival. */
const focusOnMount = (input: HTMLInputElement | null): void => {
  input?.focus({ preventScroll: true });
};

function PhoneSearchField() {
  const navigate = useNavigate();
  const location = useLocation();
  const query = new URLSearchParams(location.searchStr).get("q") ?? "";

  return (
    <label
      className={cn(
        "flex h-15.5 min-w-0 grow items-center gap-2.5 rounded-full px-4.5",
        glassClassName,
      )}
    >
      <SearchIcon aria-hidden className="size-5 text-text-muted" strokeWidth={2} />
      <input
        ref={focusOnMount}
        type="search"
        aria-label="Search your library"
        placeholder="Artists, songs, albums"
        value={query}
        onChange={(event) =>
          void navigate({ to: "/search", search: { q: event.target.value }, replace: true })
        }
        className="h-full min-w-0 grow bg-transparent font-sans text-phone-body leading-5.5 text-text outline-none placeholder:text-text-muted [&::-webkit-search-cancel-button]:hidden"
      />
      {query.length > 0 ? (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => void navigate({ to: "/search", search: { q: "" }, replace: true })}
          className="flex size-5 shrink-0 items-center justify-center rounded-full bg-text-muted/60 text-text-inverse"
        >
          <XIcon className="size-2.5" strokeWidth={3.5} />
        </button>
      ) : null}
    </label>
  );
}

/**
 * The phone chrome from Paper: a fade, the glass mini player, and the floating capsule tab bar
 * (Home, Playlists, Library) with a separate search circle. On the search screen the circle
 * becomes Home and the capsule becomes the search field.
 */
export function PhoneChrome() {
  const location = useLocation();
  const path = location.pathname;
  const onSearch = path === "/search";
  const playlists = path.startsWith("/playlists") || path === "/liked";

  const library = ["/library", "/albums", "/artists", "/songs"].some((prefix) =>
    path.startsWith(prefix),
  );

  const home = !onSearch && !playlists && !library && !path.startsWith("/settings");

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex flex-col gap-2.5 bg-linear-to-b from-bg/0 via-bg/85 via-45% to-bg px-4 pt-row pb-safe-bottom lg:hidden [&>*]:pointer-events-auto">
      <MiniPlayer />
      <nav aria-label="Main" className="flex items-center gap-2.5">
        {onSearch ? (
          <>
            <Link
              to="/"
              aria-label="Home"
              className={cn(
                "flex size-15.5 shrink-0 items-center justify-center rounded-full text-text",
                glassClassName,
              )}
            >
              <HomeGlyph filled={false} />
            </Link>
            <PhoneSearchField />
          </>
        ) : (
          <>
            <div className={cn("flex h-15.5 grow items-center rounded-full p-1", glassClassName)}>
              <Tab to="/" label="Home" icon={<HomeGlyph filled={home} />} active={home} />
              <Tab
                to="/playlists"
                label="Playlists"
                icon={<ListMusicIcon aria-hidden className="size-6" strokeWidth={1.8} />}
                active={playlists}
              />
              <Tab to="/library" label="Library" icon={<LibraryGlyph />} active={library} />
            </div>
            <Link
              to="/search"
              aria-label="Search"
              className={cn(
                "flex size-15.5 shrink-0 items-center justify-center rounded-full text-text",
                glassClassName,
              )}
            >
              <SearchIcon aria-hidden className="size-6" strokeWidth={2} />
            </Link>
          </>
        )}
      </nav>
    </div>
  );
}
