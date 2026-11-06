import { AddProfileTile, ProfileTile } from "@media/ui/components/profile-tile";
import { useNavigate } from "@tanstack/react-router";

import { useAccountActions } from "@/session/account";
import type { UserId } from "@/session/platform-types";
import type { PersonalTile } from "@/session/screen";

import { PICKER_GRID, PickerPage } from "./people/picker-page";

/**
 * The personal picker: a tile per person signed in on this device. A person whose session this
 * browser no longer holds shows a lock, and picking them asks for their password again.
 */
export function PersonalPickerView({
  tiles,
  onPick,
  onAdd,
}: {
  readonly tiles: ReadonlyArray<PersonalTile>;
  readonly onPick: (userId: UserId) => void;
  readonly onAdd: () => void;
}) {
  return (
    <PickerPage title="Who's here?">
      <ul className={PICKER_GRID}>
        {tiles.map((tile) => (
          <li key={tile.userId}>
            <ProfileTile
              name={tile.username}
              locked={!tile.here}
              aria-label={tile.here ? tile.username : `${tile.username}, sign in again`}
              onClick={() => onPick(tile.userId)}
            />
          </li>
        ))}
        <li>
          <AddProfileTile label="Add someone" onClick={onAdd} />
        </li>
      </ul>
    </PickerPage>
  );
}

/** Who is using this personal device: everyone signed in on it, and Add someone. */
export function PersonalPickerScreen({ tiles }: { readonly tiles: ReadonlyArray<PersonalTile> }) {
  const { switchTo } = useAccountActions();
  const navigate = useNavigate();

  return (
    <PersonalPickerView
      tiles={tiles}
      onPick={switchTo}
      onAdd={() => void navigate({ to: "/add" })}
    />
  );
}
