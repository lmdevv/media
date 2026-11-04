import { Avatar, EditableAvatar } from "@media/ui/components/avatar";
import { Badge } from "@media/ui/components/badge";
import { Button } from "@media/ui/components/button";
import { CalmState } from "@media/ui/components/calm-state";
import { Chip, NavChip } from "@media/ui/components/chip";
import { CodeInput } from "@media/ui/components/code-input";
import { CommandMenu } from "@media/ui/components/command-menu";
import { HeroCard, Hero } from "@media/ui/components/hero";
import { PlayGlyph } from "@media/ui/components/icons";
import { EpisodeRow, LandscapeCard, PosterCard } from "@media/ui/components/media-card";
import { MediaRow } from "@media/ui/components/media-row";
import { CompactTopBar, LargeTitle } from "@media/ui/components/phone-title";
import { PlayerButton, PlayerControls, TracksGlyph } from "@media/ui/components/player-controls";
import { AddProfileTile, ProfileTile } from "@media/ui/components/profile-tile";
import { RoomPanel } from "@media/ui/components/room-panel";
import { Spinner } from "@media/ui/components/spinner";
import { TabBar, TabBarItem, TabBarSearch } from "@media/ui/components/tab-bar";
import { TextField } from "@media/ui/components/text-field";
import { RoomPill, SearchTrigger, TopBar, TopBarLink } from "@media/ui/components/top-bar";
import { TrackPanel, TrackPopover } from "@media/ui/components/track-popover";
import type { CommandItem, CommandPage } from "@media/ui/lib/command-menu";
import {
  BookmarkIcon,
  CircleXIcon,
  EyeIcon,
  FilmIcon,
  FolderIcon,
  HouseIcon,
  InfoIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  Settings2Icon,
  TvIcon,
  UserRoundIcon,
  CaptionsIcon,
} from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";

import { moveRowFocus } from "@media/ui/lib/row-focus";
import { useKeymap } from "@media/ui/lib/use-keymap";

import { keymap, shortcutLabel } from "@/lib/keymap";

import { ART } from "./sample-art";

const AUDIO = [
  { id: "en-51", label: "English 5.1" },
  { id: "ja", label: "Japanese stereo" },
  { id: "commentary", label: "Commentary" },
] as const;

const SUBTITLES = [
  { id: "off", label: "Off" },
  { id: "en-cc", label: "English CC" },
  { id: "es", label: "Español" },
] as const;

const VERSIONS = [
  { id: "hdr", label: "HDR10 HEVC", detail: "4K · HDR10 · HEVC · EAC3 5.1 · 41.2 GB" },
  { id: "direct", label: "Direct Play", detail: "1080p · H.264 · AAC 2.0 · 2.1 GB" },
  { id: "sd", label: "SD Interlaced MPEG-2", detail: "SD · MPEG-2 · AC3 2.0 · 900 MB" },
] as const;

const LANGUAGES: ReadonlyArray<{
  readonly id: string;
  readonly title: string;
  readonly detail?: string;
}> = [
  { id: "off", title: "Off" },
  { id: "en-cc", title: "English", detail: "CC" },
  { id: "en", title: "English" },
  { id: "es", title: "Español" },
  { id: "fr", title: "Français" },
  { id: "ja", title: "日本語" },
];

const PHONE_TABS = [
  { label: "Home", icon: HouseIcon },
  { label: "Movies", icon: FilmIcon },
  { label: "Shows", icon: TvIcon },
  { label: "My List", icon: BookmarkIcon },
] as const;

const TITLES = [
  { id: "severance", title: "Severance", detail: "Show · 2022", art: ART.severancePoster },
  {
    id: "severance-s2e4",
    title: "Severance S2:E4",
    detail: "Woe's Hollow · 41m left",
    art: ART.severance,
  },
  { id: "seven-samurai", title: "Seven Samurai", detail: "Movie · 1954", art: ART.holdovers },
  { id: "dune", title: "Dune: Part Two", detail: "Movie · 2024", art: ART.dune },
] as const;

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function Section({
  title,
  children,
  className,
}: {
  readonly title: string;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <section className={className}>
      <h2 className="mb-6 font-mono text-caption/4 tracking-caps text-text-muted uppercase">
        {title}
      </h2>
      {children}
    </section>
  );
}

function DuneTitleArt() {
  return (
    <div className="flex flex-col gap-5">
      <h1 className="font-sans text-hero/26 font-hero tracking-hero">DUNE</h1>
      <p className="font-sans text-subtitle/6.5 font-tagline tracking-spread uppercase">Part Two</p>
    </div>
  );
}

const sampleMenu = (
  query: string,
  subtitle: string,
  setSubtitle: (id: string) => void,
): CommandPage => {
  const needle = query.trim().toLowerCase();

  const titleResults = TITLES.flatMap((title): ReadonlyArray<CommandItem> =>
    title.title.toLowerCase().includes(needle)
      ? [
          {
            kind: "action",
            id: `title:${title.id}`,
            title: title.title,
            detail: title.detail,
            leading: { kind: "poster", src: title.art },
            perform: () => undefined,
          },
        ]
      : [],
  );

  return {
    id: "root",
    placeholder: "Search or jump to…",
    groups: [
      {
        id: "continue",
        label: "Continue watching",
        scope: "browse",
        items: [
          {
            kind: "action",
            id: "c1",
            title: "Severance",
            detail: "S2:E4 · 38m left",
            leading: { kind: "poster", src: ART.severancePoster },
            perform: () => undefined,
          },
          {
            kind: "action",
            id: "c2",
            title: "Dune: Part Two",
            detail: "1h 03m left",
            leading: { kind: "poster", src: ART.dune },
            perform: () => undefined,
          },
          {
            kind: "action",
            id: "c3",
            title: "The Bear",
            detail: "S3:E2 · 18m left",
            leading: { kind: "poster", src: ART.bear },
            perform: () => undefined,
          },
        ],
      },
      { id: "titles", label: "Titles", scope: "search", filter: "none", items: titleResults },
      {
        id: "library",
        label: "Library",
        scope: "search",
        items: [
          {
            kind: "action",
            id: "scan-running",
            title: "Scanning all libraries",
            detail: "796 of 1,284 · about 4m",
            keywords: ["scan"],
            progress: 0.62,
            leading: { kind: "icon", icon: RefreshCwIcon },
            perform: () => undefined,
            keepOpen: true,
          },
          {
            kind: "action",
            id: "scan-one",
            title: "Scan one library…",
            keywords: ["scan"],
            leading: { kind: "icon", icon: FolderIcon },
            perform: () => undefined,
          },
          {
            kind: "action",
            id: "scan-cancel",
            title: "Cancel scan",
            keywords: ["scan"],
            keycaps: ["⌘", "."],
            leading: { kind: "icon", icon: CircleXIcon },
            perform: () => undefined,
          },
        ],
      },
      {
        id: "go",
        label: "Go to",
        items: [
          {
            kind: "action",
            id: "home",
            title: "Home",
            leading: { kind: "icon", icon: HouseIcon },
            keycaps: keymap.keycaps("go.home"),
            perform: () => undefined,
          },
          {
            kind: "action",
            id: "list",
            title: "My List",
            leading: { kind: "icon", icon: BookmarkIcon },
            keycaps: keymap.keycaps("go.my-list"),
            perform: () => undefined,
          },
          {
            kind: "action",
            id: "settings",
            title: "Settings",
            leading: { kind: "icon", icon: Settings2Icon },
            keycaps: keymap.keycaps("go.settings"),
            perform: () => undefined,
          },
        ],
      },
      {
        id: "actions",
        label: "Actions",
        items: [
          {
            kind: "action",
            id: "profile",
            title: "Switch profile",
            detail: "Alex",
            leading: { kind: "icon", icon: UserRoundIcon },
            keycaps: ["⌘", "⇧", "P"],
            perform: () => undefined,
          },
          {
            kind: "submenu",
            id: "subtitles",
            title: "Subtitles…",
            leading: { kind: "icon", icon: CaptionsIcon },
            keycaps: ["C"],
            page: {
              id: "subtitles",
              breadcrumb: "Subtitles · Severance",
              placeholder: "Language…",
              groups: [
                {
                  id: "languages",
                  items: LANGUAGES.map((language): CommandItem => ({
                    kind: "action",
                    id: language.id,
                    title: language.title,
                    detail: language.detail,
                    checked: language.id === subtitle,
                    perform: () => setSubtitle(language.id),
                  })),
                },
              ],
            },
          },
          {
            kind: "action",
            id: "scan",
            title: "Scan libraries",
            leading: { kind: "icon", icon: RefreshCwIcon },
            perform: () => wait(1500),
            keepOpen: true,
          },
        ],
      },
    ],
    fallback: () => [
      {
        kind: "action",
        id: "unmatched",
        title: "Search unmatched files",
        leading: { kind: "icon", icon: SearchIcon },
        perform: () => undefined,
      },
      {
        kind: "action",
        id: "scan-fallback",
        title: "Scan libraries",
        leading: { kind: "icon", icon: RefreshCwIcon },
        perform: () => undefined,
      },
    ],
  };
};

/**
 * Every [movies] UI kit component with sample data, laid out like Paper's 02 Components page, for
 * visual comparison. Development builds only.
 */
export function KitGallery() {
  const [playing, setPlaying] = useState(true);
  const [position, setPosition] = useState(1882);
  const [muted, setMuted] = useState(false);
  const [audio, setAudio] = useState("en-51");
  const [subtitle, setSubtitle] = useState("en-cc");

  const [version, setVersion] = useState("direct");

  const trackChoices = [
    { id: "audio", label: "Audio", options: AUDIO, value: audio, onValueChange: setAudio },
    {
      id: "subtitles",
      label: "Subtitles",
      options: SUBTITLES,
      value: subtitle,
      onValueChange: setSubtitle,
    },
  ];

  const [chip, setChip] = useState("all");
  const [code, setCode] = useState("HD5R5GTL");
  const [pin, setPin] = useState("4821");
  const [menuOpen, setMenuOpen] = useState(false);
  const [query, setQuery] = useState("");
  const duration = 3480;

  useKeymap(keymap, {
    "menu.toggle": () => setMenuOpen((open) => !open),
    "search.open": () => setMenuOpen(true),
    "rows.next": () => moveRowFocus(1),
    "rows.previous": () => moveRowFocus(-1),
  });

  const topBar = (overMedia: boolean) => (
    <TopBar
      overMedia={overMedia}
      nav={["Home", "Movies", "Shows", "My List"].map((label, index) => (
        <TopBarLink key={label} href="#" active={index === 0}>
          {label}
        </TopBarLink>
      ))}
      actions={
        <>
          <SearchTrigger keycaps={shortcutLabel("menu.toggle")} onClick={() => setMenuOpen(true)} />
          <RoomPill count={3} />
          <Avatar name="Alex" image={ART.alex} />
        </>
      }
    />
  );

  return (
    <div className="min-h-svh bg-page pb-32 text-text">
      <Hero
        title="Dune: Part Two"
        titleArt={<DuneTitleArt />}
        backdrop={ART.dune}
        highlight="New this week"
        facts="2024 · 2h 46m · PG-13"
        badges={
          <>
            <Badge>4K HDR</Badge>
            <Badge>ATMOS</Badge>
          </>
        }
        overview="Paul Atreides unites with Chani and the Fremen while seeking revenge against the conspirators who destroyed his family."
        topBar={topBar(true)}
        actions={
          <>
            <Button size="lg">
              <PlayGlyph />
              Play
            </Button>
            <Button variant="secondary" size="lg">
              <InfoIcon strokeWidth={1.75} aria-hidden />
              More info
            </Button>
          </>
        }
      />

      <div className="flex flex-col gap-11">
        <MediaRow title="Continue watching for Alex" seeAll={<a href="#" />}>
          <LandscapeCard
            href="#"
            title="Dune: Part Two"
            subtitle="1h 03m left"
            image={ART.dune}
            progress={0.62}
          />
          <LandscapeCard
            href="#"
            title="Severance · S2:E4"
            subtitle="41m left"
            image={ART.severance}
            progress={0.3}
          />
          <LandscapeCard
            href="#"
            title="The Bear · S3:E2"
            subtitle="18m left"
            image={ART.bear}
            progress={0.55}
          />
          <LandscapeCard
            href="#"
            title="Shōgun · S1:E7"
            subtitle="52m left"
            image={ART.shogun}
            progress={0.12}
          />
          <LandscapeCard
            href="#"
            title="Past Lives"
            subtitle="22m left"
            image={ART.pastLives}
            progress={0.8}
          />
        </MediaRow>
        <MediaRow title="Recently added" seeAll={<a href="#" />}>
          <PosterCard href="#" title="Perfect Days" image={ART.perfectDays} badge="New" />
          <PosterCard href="#" title="Andor" image={ART.andor} badge="New" />
          <PosterCard href="#" title="Blue Eye Samurai" image={ART.severancePoster} />
          <PosterCard href="#" title="Arrival" image={ART.arrival} />
          <PosterCard href="#" title="The Holdovers" image={ART.holdovers} badge="New" />
          <PosterCard href="#" title="Poor Things" image={ART.poorThings} />
          <PosterCard href="#" title="Fallen Leaves" image={ART.shogun} />
          <PosterCard href="#" title="Civil War" image={ART.bladeRunner} />
        </MediaRow>
      </div>

      <div className="mx-auto mt-20 flex max-w-content flex-col gap-14 px-16 box-content">
        <Section title="Top bar">{topBar(false)}</Section>

        <Section title="Cards">
          <div className="flex items-start gap-8">
            <LandscapeCard
              href="#"
              title="Dune: Part Two"
              subtitle="1h 03m left"
              image={ART.dune}
              progress={0.62}
            />
            <PosterCard
              href="#"
              title="Severance"
              image={ART.severancePoster}
              badge="New episode"
            />
            <EpisodeRow
              href="#"
              number={4}
              title="Woe's Hollow"
              runtime="52m"
              synopsis="The team's outdoor retreat takes a strange turn as Mark pushes for answers about the board."
              facts="HEVC · DIRECT · 41m left"
              image={ART.severance}
              progress={0.3}
            />
          </div>
        </Section>

        <Section title="Buttons and inputs">
          <div className="flex flex-wrap items-center gap-4">
            <Button>
              <PlayGlyph />
              Play
            </Button>
            <Button variant="secondary">
              <InfoIcon strokeWidth={1.75} aria-hidden />
              More info
            </Button>
            <Button variant="icon" size="icon" aria-label="Add to My List">
              <PlusIcon strokeWidth={1.75} aria-hidden />
            </Button>
            <Button variant="ghost" size="sm">
              Cancel
            </Button>
            <Button variant="destructive" size="sm">
              Revoke key
            </Button>
            <Button variant="subtle" size="sm">
              Copy invite link
            </Button>
            <TextField label="Email" defaultValue="alex@home.lan" className="w-70" />
            <Chip selected={chip === "all"} onClick={() => setChip("all")}>
              All
            </Chip>
            <Chip selected={chip === "sci-fi"} onClick={() => setChip("sci-fi")}>
              Sci-fi
            </Chip>
            <Badge>4K HDR</Badge>
          </div>
          <div className="mt-8 flex items-start gap-8">
            <TextField
              label="Password"
              type="password"
              defaultValue="hunter2hunter"
              error="Wrong password. 2 tries left."
              className="w-100"
              labelAction={
                <a href="#" className="font-sans text-label/4 font-medium text-text">
                  Forgot?
                </a>
              }
              trailing={<EyeIcon className="size-4.5" strokeWidth={1.75} aria-hidden />}
            />
          </div>
        </Section>

        <Section title="Player">
          <div className="flex items-end gap-8">
            <div className="w-205 overflow-hidden rounded-control bg-dark-bg">
              <PlayerControls
                title="Severance S2:E4 Woe's Hollow"
                playing={playing}
                position={position}
                duration={duration}
                muted={muted}
                onPlayPause={() => setPlaying((value) => !value)}
                onSeek={setPosition}
                onMuteChange={setMuted}
                onNext={() => undefined}
                onRoom={() => undefined}
                onFullscreen={() => undefined}
                tracks={
                  <TrackPopover
                    trigger={
                      <PlayerButton aria-label="Audio and subtitles">
                        <TracksGlyph />
                      </PlayerButton>
                    }
                    label="Audio and subtitles"
                    choices={trackChoices}
                  />
                }
              />
            </div>
            <TrackPanel choices={trackChoices} />
            <TrackPanel
              choices={[
                {
                  id: "version",
                  label: "Version",
                  options: VERSIONS,
                  value: version,
                  onValueChange: setVersion,
                },
                ...trackChoices,
              ]}
            />
          </div>
        </Section>

        <Section title="Overlays">
          <div className="flex items-start gap-8">
            <RoomPanel
              className="h-110"
              members={[
                { id: "alex", name: "Alex", detail: "Host", avatar: ART.alex },
                { id: "maya", name: "Maya", detail: "You", avatar: ART.maya },
                {
                  id: "sam",
                  name: "Sam",
                  avatar: ART.sam,
                  status: { kind: "drift", label: "-2.4s" },
                },
              ]}
              onCopyLink={() => undefined}
              onEnd={() => undefined}
            />
            <Button variant="subtle" size="sm" onClick={() => setMenuOpen(true)}>
              Open command menu
            </Button>
          </div>
        </Section>

        <Section title="States">
          <div className="grid grid-cols-2 gap-8">
            <div className="on-media flex h-110 items-center rounded-card bg-dark-surface">
              <CalmState
                visual={<Spinner className="size-12 text-text" />}
                title="Trying another way to play"
                description="Resuming at 1:12:44"
                actions={
                  <Button variant="ghost" size="sm">
                    Back to details
                  </Button>
                }
              />
            </div>
            <div className="flex h-110 items-center rounded-card bg-surface">
              <CalmState
                title="No libraries yet"
                description="Add a folder of movies or shows from this machine or your NAS."
                actions={
                  <>
                    <Button>
                      <FolderIcon strokeWidth={1.75} aria-hidden />
                      Add library
                    </Button>
                    <Button variant="subtle">Import from Jellyfin or Plex</Button>
                  </>
                }
              />
            </div>
          </div>
        </Section>

        <Section title="Codes and profiles">
          <div className="flex flex-col gap-10">
            <CodeInput
              length={8}
              groupSize={4}
              value={code}
              onValueChange={setCode}
              label="Code from your TV"
            />
            <CodeInput
              kind="pin"
              length={4}
              value={pin}
              onValueChange={setPin}
              invalid
              label="Alex's PIN"
            />
            <div className="flex items-start gap-8">
              <ProfileTile name="Alex" image={ART.alex} monogram locked />
              <ProfileTile name="Kids" image={ART.kids} />
              <AddProfileTile />
              <EditableAvatar name="Kids" image={ART.kids} onEdit={() => undefined} />
            </div>
          </div>
        </Section>

        <Section title="Phone · 390">
          <div className="flex items-start gap-10">
            <div className="relative h-211 w-97.5 shrink-0 overflow-hidden bg-bg">
              <LargeTitle
                title="For Alex"
                className="pt-12"
                trailing={<Avatar name="Alex" image={ART.alex} round />}
              />
              <div className="flex gap-2 px-5 pb-4">
                <NavChip href="#">Movies</NavChip>
                <NavChip href="#">Shows</NavChip>
                <NavChip href="#" live>
                  Room live
                </NavChip>
              </div>
              <div className="px-4">
                <HeroCard
                  title="Dune"
                  backdrop={ART.dune}
                  titleArt={
                    <p className="font-sans text-hero-card/10.5 font-hero tracking-display">DUNE</p>
                  }
                  facts="Sci-fi · Epic · 2024"
                  actions={
                    <>
                      <Button size="pill">
                        <PlayGlyph className="size-4" />
                        Resume
                      </Button>
                      <Button variant="glass" size="pill">
                        <PlusIcon strokeWidth={2} aria-hidden />
                        My List
                      </Button>
                    </>
                  }
                />
              </div>
              <MediaRow title="Continue watching" seeAll={<a href="#" />}>
                <LandscapeCard
                  href="#"
                  size="phone"
                  title="S2:E4 · Woe's Hollow"
                  subtitle="41m left"
                  image={ART.severance}
                  progress={0.3}
                />
              </MediaRow>
              <TabBar className="absolute inset-x-4 bottom-6" search={<TabBarSearch />}>
                {PHONE_TABS.map((tab, index) => (
                  <TabBarItem
                    key={tab.label}
                    href="#"
                    label={tab.label}
                    active={index === 0}
                    icon={<tab.icon strokeWidth={1.75} aria-hidden />}
                  />
                ))}
              </TabBar>
            </div>

            <div className="relative h-211 w-97.5 shrink-0 overflow-hidden bg-bg">
              <CompactTopBar
                title="For Alex"
                visible
                className="absolute inset-x-0 top-0 z-10 pt-12"
                trailing={<Avatar name="Alex" image={ART.alex} size="xs" round />}
              />
              <div className="flex flex-col pt-24">
                <MediaRow title="Recently added" seeAll={<a href="#" />}>
                  <LandscapeCard
                    href="#"
                    size="phone"
                    title="Arrival"
                    subtitle="2016 · 1h 56m"
                    image={ART.arrival}
                  />
                  <LandscapeCard
                    href="#"
                    size="phone"
                    title="Poor Things"
                    subtitle="2023 · 2h 21m"
                    image={ART.poorThings}
                  />
                </MediaRow>
                <MediaRow title="Because you watched Dune" seeAll={<a href="#" />}>
                  <LandscapeCard
                    href="#"
                    size="phone"
                    title="Sicario"
                    subtitle="2015 · 2h 1m"
                    image={ART.sicario}
                  />
                  <LandscapeCard
                    href="#"
                    size="phone"
                    title="Interstellar"
                    subtitle="2014 · 2h 49m"
                    image={ART.severance}
                  />
                </MediaRow>
              </div>
              <TabBar minimized className="absolute inset-x-4 bottom-6" search={<TabBarSearch />}>
                {PHONE_TABS.map((tab, index) => (
                  <TabBarItem
                    key={tab.label}
                    href="#"
                    label={tab.label}
                    active={index === 0}
                    icon={<tab.icon strokeWidth={1.75} aria-hidden />}
                  />
                ))}
              </TabBar>
            </div>
          </div>
        </Section>
      </div>

      <CommandMenu
        open={menuOpen}
        onOpenChange={setMenuOpen}
        root={sampleMenu(query, subtitle, setSubtitle)}
        onQueryChange={(next) => setQuery(next)}
      />
    </div>
  );
}
