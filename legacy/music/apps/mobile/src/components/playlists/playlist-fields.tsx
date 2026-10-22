/**
 * A playlist's name and description fields, as New playlist (C04) and Edit (C07) draw them, with
 * the server's length limits.
 */
import { Field } from "@/components/ui/field";

/** The name and description being typed. */
export interface PlaylistText {
  readonly name: string;
  readonly description: string;
}

/** Props for `PlaylistFields`. */
export interface PlaylistFieldsProps {
  readonly value: PlaylistText;
  readonly onChange: (value: PlaylistText) => void;
  /** What Description is called: `Description (optional)` when creating. */
  readonly descriptionLabel: string;
  /** Submits the form from the keyboard's Done key. */
  readonly onSubmit: () => void;
  /** Why the server refused the form. */
  readonly error: string | null;
  readonly autoFocus?: boolean;
}

/** Whether `text` can be saved: a name that isn't blank. */
export const isSavable = (text: PlaylistText): boolean => text.name.trim().length > 0;

/** Name, then Description; Done on either submits. */
export function PlaylistFields({
  value,
  onChange,
  descriptionLabel,
  onSubmit,
  error,
  autoFocus = false,
}: PlaylistFieldsProps) {
  return (
    <>
      <Field
        label="Name"
        value={value.name}
        onChangeText={(name) => onChange({ ...value, name })}
        placeholder="Playlist name"
        autoCapitalize="sentences"
        autoFocus={autoFocus}
        maxLength={120}
        returnKeyType="done"
        submitBehavior="blurAndSubmit"
        onSubmitEditing={onSubmit}
        error={error}
      />
      <Field
        label={descriptionLabel}
        value={value.description}
        onChangeText={(description) => onChange({ ...value, description })}
        placeholder="What it’s for"
        autoCapitalize="sentences"
        maxLength={500}
        returnKeyType="done"
        onSubmitEditing={onSubmit}
      />
    </>
  );
}
