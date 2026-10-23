/** The glyph each command group shows on its Actions rows and in its form's callout. */
import type { CommandGroup } from "@music/commands/command";
import {
  Download,
  Folder,
  Heart,
  Key,
  Library,
  ListMusic,
  ListOrdered,
  Monitor,
  Play,
  RotateCw,
  Search,
  Settings,
  User,
  Users,
} from "lucide-react-native";
import type { LucideIcon } from "lucide-react-native";

/** Paper draws Play music with play, devices with a monitor, and Jams and invites with people. */
export const GROUP_ICON = {
  playback: Play,
  queue: ListOrdered,
  devices: Monitor,
  downloads: Download,
  likes: Heart,
  jams: Users,
  library: Library,
  search: Search,
  playlists: ListMusic,
  account: User,
  keys: Key,
  libraries: Folder,
  jobs: RotateCw,
  people: Users,
  server: Settings,
} as const satisfies Record<CommandGroup, LucideIcon>;
