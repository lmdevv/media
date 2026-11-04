import { Avatar } from "@media/ui/components/avatar";
import { CommandMenu } from "@media/ui/components/command-menu";
import { CompactTopBar, LargeTitle } from "@media/ui/components/phone-title";
import { TabBar, TabBarItem, TabBarSearch } from "@media/ui/components/tab-bar";
import { RoomPill, SearchTrigger, TopBar, TopBarLink } from "@media/ui/components/top-bar";
import { Wordmark } from "@media/ui/components/wordmark";
import { moveRowFocus } from "@media/ui/lib/row-focus";
import { useKeymap } from "@media/ui/lib/use-keymap";
import { cn } from "@media/ui/lib/utils";
import { Link, useLocation, useMatches, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";

import { SWITCH_PROFILE_COMMAND, useCommandRoot } from "@/commands";
import { TitlePrefetchProvider } from "@/components/browse/prefetch";
import { profileArt } from "@/components/profiles/profile-art";
import { returnTarget, useCurrentRoom } from "@/lib/current-room";
import { keymap, shortcutLabel } from "@/lib/keymap";
import { useActiveProfile } from "@/session/guards";
import { useScopes } from "@/session/viewer";

import { InShell } from "./route-states";
import { ScanToast } from "./scan-toast";
import { SECTIONS, sectionOf } from "./sections";

const SCROLL_THRESHOLD_PX = 48;

function useScrolledPast(threshold: number): boolean {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const update = (): void => setScrolled(window.scrollY > threshold);

    update();
    window.addEventListener("scroll", update, { passive: true });

    return () => window.removeEventListener("scroll", update);
  }, [threshold]);

  return scrolled;
}

type MenuState = { readonly open: false } | { readonly open: true; readonly start?: string };

/**
 * The signed-in app frame. At `md` and up: the Netflix-style top bar, transparent over a route's
 * hero and solid once scrolled. Below `md`: a large title that hands over to a compact glass bar,
 * and the floating glass tab bar with its search circle. It hosts the command menu, the global
 * keyboard shortcuts, and the scanning toast. Must sit inside `RequireProfile` and
 * `CurrentRoomProvider`.
 *
 * While this device is in a watch room with the active profile, the bars show the room pill, a
 * link back into the room: "Room · N" at `md` and up; on phones the compact form beside the
 * avatar, and on pages without a phone title of their own over a hero's artwork (a title's page)
 * or above the page (a person). Search, whose Cancel holds that corner, leaves it to the bars.
 *
 * A route opts into the transparent bar over its billboard with `staticData: { hero: true }`, and
 * out of the phone large title with `staticData: { phoneTitle: false }`.
 */
export function AppShell({ children }: { readonly children: ReactNode }) {
  const { profile, profiles } = useActiveProfile();
  const scopes = useScopes();
  const [menu, setMenu] = useState<MenuState>({ open: false });
  const [query, setQuery] = useState("");
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });

  const hero = useMatches({
    select: (matches) => matches.some((match) => match.staticData.hero === true),
  });

  const phoneTitle = useMatches({
    select: (matches) => !matches.some((match) => match.staticData.phoneTitle === false),
  });

  const scrolled = useScrolledPast(SCROLL_THRESHOLD_PX);
  const deviceRoom = useCurrentRoom();
  const pillRoom = deviceRoom?.mine === true && deviceRoom.returnable ? deviceRoom : null;
  const current = sectionOf(pathname);
  const art = profileArt(profile);

  const title =
    pathname === "/"
      ? `For ${profile.name}`
      : (current?.label ?? (pathname.startsWith("/settings") ? "Settings" : ""));

  const root = useCommandRoot({ navigate, query, profile, profiles, scopes, player: null });

  const openMenu = useCallback((start?: string) => {
    setMenu(start === undefined ? { open: true } : { open: true, start });
  }, []);

  useKeymap(keymap, {
    "menu.toggle": () => setMenu((state) => (state.open ? { open: false } : { open: true })),
    "search.open": () => openMenu(),
    "profile.switch": () => openMenu(SWITCH_PROFILE_COMMAND),
    "go.home": () => void navigate({ to: "/" }),
    "go.movies": () => void navigate({ to: "/movies" }),
    "go.shows": () => void navigate({ to: "/shows" }),
    "go.my-list": () => void navigate({ to: "/my-list" }),
    "go.settings": () => void navigate({ to: "/settings" }),
    "rows.next": () => moveRowFocus(1),
    "rows.previous": () => moveRowFocus(-1),
  });

  const overMedia = hero && !scrolled;

  const profileButton = (size: "xs" | "sm", round: boolean) => (
    <button
      type="button"
      aria-label={`${profile.name}: switch profile`}
      onClick={() => openMenu(SWITCH_PROFILE_COMMAND)}
      className={cn("cursor-pointer", round ? "rounded-pill" : "rounded-poster")}
    >
      <Avatar name={profile.name} image={art.image} monogram={false} size={size} round={round} />
    </button>
  );

  const roomPill = (compact: boolean, className?: string) => {
    if (pillRoom === null) return null;
    const count = pillRoom.members;

    return (
      <RoomPill
        count={count}
        compact={compact}
        className={className}
        aria-label={`Room · ${String(count)}: return to ${pillRoom.titleName}`}
        render={<Link {...returnTarget(pillRoom)} />}
      />
    );
  };

  const heroPill = hero && (!phoneTitle || title === "");

  const trailing = (size: "xs" | "sm") => (
    <span className="flex items-center gap-3">
      {roomPill(true)}
      {profileButton(size, true)}
    </span>
  );

  return (
    <div className="min-h-svh bg-page text-text">
      <div
        className={cn(
          "fixed inset-x-0 top-0 z-40 hidden px-16 transition-colors duration-200 md:block",
          overMedia ? "bg-linear-to-b from-dark-bg/55 to-transparent" : "bg-page",
        )}
      >
        <TopBar
          overMedia={overMedia}
          className="mx-auto max-w-content"
          brand={
            <Link to="/" aria-label="[movies] home" className="rounded-bar">
              <Wordmark />
            </Link>
          }
          nav={SECTIONS.map((section) => (
            <TopBarLink
              key={section.to}
              active={current?.to === section.to}
              render={<Link to={section.to} />}
            >
              {section.label}
            </TopBarLink>
          ))}
          actions={
            <>
              <SearchTrigger
                keycaps={shortcutLabel("menu.toggle")}
                aria-keyshortcuts="Meta+K Control+K"
                onClick={() => openMenu()}
              />
              {roomPill(false)}
              {profileButton("sm", false)}
            </>
          }
        />
      </div>

      {phoneTitle ? (
        <CompactTopBar
          title={title}
          visible={scrolled}
          className="fixed inset-x-0 top-0 z-40 md:hidden"
          trailing={trailing("xs")}
        />
      ) : null}

      {!heroPill || (scrolled && phoneTitle) || pillRoom === null ? null : (
        <div className="on-media fixed top-[max(env(safe-area-inset-top),var(--spacing-12))] right-4 z-40 flex h-10 items-center md:hidden">
          {roomPill(true, "bg-glass backdrop-blur-xl")}
        </div>
      )}

      <main className={cn("pb-32 md:pb-20", !hero && "md:pt-17")}>
        {phoneTitle && title === "" && !hero && pillRoom !== null ? (
          <div className="flex justify-end px-5 pt-[max(env(safe-area-inset-top),var(--spacing-4))] md:hidden">
            {roomPill(true)}
          </div>
        ) : null}
        {title === "" || !phoneTitle ? null : (
          <LargeTitle
            title={title}
            className="pt-[max(env(safe-area-inset-top),var(--spacing-4))] md:hidden"
            trailing={trailing("sm")}
          />
        )}
        <TitlePrefetchProvider profileId={profile.id}>
          <InShell>{children}</InShell>
        </TitlePrefetchProvider>
      </main>

      <TabBar
        minimized={scrolled}
        className="fixed inset-x-4 bottom-[max(env(safe-area-inset-bottom),var(--spacing-6))] z-40 md:hidden"
        search={
          <TabBarSearch
            onClick={() => void navigate({ to: "/search" })}
            className={cn(pathname === "/search" && "text-accent")}
          />
        }
      >
        {SECTIONS.map((section) => (
          <TabBarItem
            key={section.to}
            label={section.label}
            icon={<section.icon strokeWidth={1.75} aria-hidden />}
            active={current?.to === section.to}
            render={<Link to={section.to} />}
          />
        ))}
      </TabBar>

      {scopes.has("manage") ? <ScanToast /> : null}

      <CommandMenu
        open={menu.open}
        start={menu.open ? menu.start : undefined}
        onOpenChange={(open) => {
          setMenu(open ? { open: true } : { open: false });

          if (!open) setQuery("");
        }}
        onQueryChange={(text, page) => {
          if (page.id === "root") setQuery(text);
        }}
        root={root}
      />
    </div>
  );
}
