import type { LibraryDetail } from "@media/contracts/models/catalog";
import { LibraryAccess, LibraryKind } from "@media/contracts/models/catalog";
import { useCommand } from "@media/sdk/react";
import { Button } from "@media/ui/components/button";
import { Chip } from "@media/ui/components/chip";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogFooter,
} from "@media/ui/components/dialog";
import { FieldError, TextField } from "@media/ui/components/text-field";
import { Input } from "@media/ui/components/input";
import { Switch } from "@media/ui/components/switch";
import { useNavigate } from "@tanstack/react-router";
import { PlusIcon, XIcon } from "lucide-react";
import { useState } from "react";
import type { Dispatch, FormEvent, ReactNode, SetStateAction } from "react";

import { useAction } from "./action";
import { KIND_LABELS } from "./format";

const ACCESS_LABELS: Readonly<Record<LibraryAccess, string>> = {
  everyone: "Everyone",
  restricted: "Only people I choose",
};

function ChoiceRow<Value extends string>({
  label,
  values,
  value,
  labels,
  onChange,
}: {
  readonly label: string;
  readonly values: ReadonlyArray<Value>;
  readonly value: Value;
  readonly labels: Readonly<Record<Value, string>>;
  readonly onChange: (value: Value) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-col gap-2">
      <span className="font-sans text-label/caption font-medium text-text-muted">{label}</span>
      <div className="flex flex-wrap gap-2">
        {values.map((each) => (
          <Chip
            key={each}
            role="radio"
            aria-checked={each === value}
            selected={each === value}
            onClick={() => onChange(each)}
          >
            {labels[each]}
          </Chip>
        ))}
      </div>
    </div>
  );
}

/**
 * Add a library, or change one's name, folders, access, and scrub thumbnails. Editing also offers
 * Generate now (thumbnails for every file that has none) and Remove, which asks again before it
 * forgets the library; files on disk are never touched.
 *
 * @param library - The library to edit; omit to add one.
 */
export function LibraryDialog({
  open,
  onOpenChange,
  library,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly library?: LibraryDetail | undefined;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? <LibraryForm library={library} onDone={() => onOpenChange(false)} /> : null}
    </Dialog>
  );
}

interface StartingValues {
  readonly name: string;
  readonly kind: LibraryKind;
  readonly access: LibraryAccess;
  readonly roots: ReadonlyArray<string>;
  readonly trickplay: boolean;
}

const startingValues = (library: LibraryDetail | undefined): StartingValues => ({
  name: library?.name ?? "",
  kind: library?.kind ?? "movies",
  access: library?.access ?? "everyone",
  roots: library?.roots ?? [""],
  trickplay: library?.trickplay ?? true,
});

function LibraryForm({
  library,
  onDone,
}: {
  readonly library: LibraryDetail | undefined;
  readonly onDone: () => void;
}) {
  const create = useCommand("libraries.create");
  const update = useCommand("libraries.update");
  const start = startingValues(library);
  const [name, setName] = useState(start.name);
  const [kind, setKind] = useState<LibraryKind>(start.kind);
  const [access, setAccess] = useState<LibraryAccess>(start.access);
  const [roots, setRoots] = useState<ReadonlyArray<string>>(start.roots);
  const [trickplay, setTrickplay] = useState(start.trickplay);
  const [removing, setRemoving] = useState(false);
  const folders = roots.map((root) => root.trim()).filter((root) => root.length > 0);
  const relative = folders.some((root) => !root.startsWith("/"));

  const save = useAction(
    async () => {
      if (library === undefined) {
        await create({ name: name.trim(), kind, roots: folders, access });

        return `Added ${name.trim()}. Scanning now.`;
      }

      await update({
        libraryId: library.id,
        name: name.trim(),
        roots: folders,
        access,
        trickplay,
      });

      return `Saved ${name.trim()}`;
    },
    { quiet: true, success: (message) => message },
  );

  if (library !== undefined && removing) {
    return <RemoveLibrary library={library} onCancel={() => setRemoving(false)} onDone={onDone} />;
  }

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();

    if ((await save.run()) !== undefined) onDone();
  };

  return (
    <DialogContent title={library === undefined ? "Add library" : "Library settings"}>
      <form onSubmit={(event) => void submit(event)}>
        <DialogBody>
          <TextField
            label="Name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={80}
            required
            autoComplete="off"
          />
          {library === undefined ? (
            <ChoiceRow
              label="Type"
              values={LibraryKind.literals}
              value={kind}
              labels={KIND_LABELS}
              onChange={setKind}
            />
          ) : null}
          <FolderFields roots={roots} relative={relative} onRootsChange={setRoots} />
          <ChoiceRow
            label="Who sees it"
            values={LibraryAccess.literals}
            value={access}
            labels={ACCESS_LABELS}
            onChange={setAccess}
          />
          {library === undefined ? null : (
            <TrickplayRow library={library} checked={trickplay} onCheckedChange={setTrickplay} />
          )}
          {save.error === undefined ? null : <FieldError>{save.error}</FieldError>}
        </DialogBody>
        <LibraryFormFooter
          adding={library === undefined}
          disabled={save.pending || name.trim().length === 0 || folders.length === 0 || relative}
          onRemove={() => setRemoving(true)}
        />
      </form>
    </DialogContent>
  );
}

function LibraryFormFooter({
  adding,
  disabled,
  onRemove,
}: {
  readonly adding: boolean;
  readonly disabled: boolean;
  readonly onRemove: () => void;
}) {
  return (
    <DialogFooter className={adding ? undefined : "justify-between"}>
      {adding ? null : (
        <Button variant="destructive" size="dialog" onClick={onRemove}>
          Remove library
        </Button>
      )}
      <span className="flex items-center gap-2">
        <DialogClose render={<Button variant="ghost" size="dialog" />}>Cancel</DialogClose>
        <Button type="submit" size="dialog" disabled={disabled}>
          {adding ? "Add library" : "Save"}
        </Button>
      </span>
    </DialogFooter>
  );
}

function FolderFields({
  roots,
  relative,
  onRootsChange,
}: {
  readonly roots: ReadonlyArray<string>;
  readonly relative: boolean;
  readonly onRootsChange: Dispatch<SetStateAction<ReadonlyArray<string>>>;
}) {
  const setRoot = (index: number, value: string): void =>
    onRootsChange((current) => current.map((root, at) => (at === index ? value : root)));

  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="pb-1.5 font-sans text-label/caption font-medium text-text-muted">
        Folders
      </legend>
      {roots.map((root, index) => (
        <div key={index} className="flex items-center gap-2">
          <Input
            aria-label={`Folder ${index + 1}`}
            value={root}
            onChange={(event) => setRoot(index, event.target.value)}
            placeholder="/mnt/nas/movies"
            className="font-mono text-label/label"
            aria-invalid={(root.trim().length > 0 && !root.trim().startsWith("/")) || undefined}
          />
          {roots.length > 1 ? (
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Remove folder ${index + 1}`}
              onClick={() => onRootsChange((current) => current.filter((_, at) => at !== index))}
            >
              <XIcon strokeWidth={1.75} aria-hidden />
            </Button>
          ) : null}
        </div>
      ))}
      {relative ? <FieldError>Folders are absolute paths, starting with /.</FieldError> : null}
      {roots.length < 20 ? (
        <button
          type="button"
          onClick={() => onRootsChange((current) => [...current, ""])}
          className="flex h-9 w-fit cursor-pointer items-center gap-2 font-sans text-label/label font-medium text-text-muted hover:text-text"
        >
          <PlusIcon className="size-3.5" strokeWidth={2} aria-hidden />
          Add a folder
        </button>
      ) : null}
    </fieldset>
  );
}

function TrickplayRow({
  library,
  checked,
  onCheckedChange,
}: {
  readonly library: LibraryDetail;
  readonly checked: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
}) {
  const generate = useCommand("libraries.generateTrickplay");

  const action = useAction(() => generate({ libraryId: library.id }), {
    success: () => `Making scrub thumbnails for ${library.name}`,
  });

  return (
    <div className="flex items-center gap-4">
      <span className="grow font-sans text-body/5 font-semibold text-text">
        Generate scrub thumbnails
      </span>
      <Button
        variant="raised"
        size="xs"
        disabled={action.pending}
        onClick={() => void action.run()}
      >
        Generate now
      </Button>
      <Switch
        checked={checked}
        onCheckedChange={onCheckedChange}
        aria-label="Generate scrub thumbnails"
      />
    </div>
  );
}

function RemoveLibrary({
  library,
  onCancel,
  onDone,
}: {
  readonly library: LibraryDetail;
  readonly onCancel: () => void;
  readonly onDone: () => void;
}): ReactNode {
  const remove = useCommand("libraries.remove");
  const navigate = useNavigate();

  const action = useAction(() => remove({ libraryId: library.id }), {
    success: () => `Removed ${library.name}`,
    onSuccess: () => {
      onDone();
      void navigate({ to: "/admin/libraries" });
    },
  });

  return (
    <DialogContent title={`Remove “${library.name}”?`} size="sm">
      <DialogBody>
        <p className="font-sans text-body/body text-text-muted">
          Its titles leave [movies] for everyone. The files in its folders stay where they are.
        </p>
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" size="dialog" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="destructive"
          size="dialog"
          disabled={action.pending}
          onClick={() => void action.run()}
        >
          Remove library
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
