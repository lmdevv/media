import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { onDisk } from "./disk";
import type { DownloadDisk, Transfer } from "./disk";

type Change = "lands" | "cut" | "dead";

/**
 * A downloads folder in a directory on this computer, which a test can kill, fill up, or make
 * fail to read the way a phone's can. A write cut short by a kill leaves the first half of its
 * text, as a native write does; a write to a full disk leaves its file empty; a move over a file
 * deletes that file first, as expo-file-system's does; a rename lands whole or not at all, as one
 * native `rename` does, and works on a full disk. Once killed, nothing more reaches the disk.
 * It starts no transfers.
 */
export class NodeDisk implements DownloadDisk {
  readonly #root: string;
  /** File changes that still land before the app dies during the next; null never dies. */
  #landing: number | null = null;
  #dead = false;
  /** Whether writes run out of space. */
  full = false;
  readonly #readFailures = new Map<string, number>();
  #listFailures = 0;
  readonly #hidden = new Set<string>();
  #renamesFail = false;

  constructor(root: string) {
    this.#root = root;
  }

  /** Kills the app during its `nth` file change from now, 1 being the next. */
  killAt(nth: number): void {
    this.#landing = nth - 1;
  }

  /** Fails the next `times` reads of `path` with an I/O error; by default, every read from now. */
  failReads(path: string, times: number = Number.POSITIVE_INFINITY): void {
    this.#readFailures.set(path, times);
  }

  /** Fails the next `times` listings of the person's folder; by default, every listing from now. */
  failLists(times: number = Number.POSITIVE_INFINITY): void {
    this.#listFailures = times;
  }

  /** Leaves `name` out of every listing of the person's folder, as a listing that missed it. */
  hideFromLists(name: string): void {
    this.#hidden.add(name);
  }

  /** Fails every rename from now with an I/O error. */
  failRenames(): void {
    this.#renamesFail = true;
  }

  #fails(path: string): boolean {
    const left = this.#readFailures.get(path) ?? 0;

    if (left > 0) this.#readFailures.set(path, left - 1);

    return left > 0;
  }

  #change(): Change {
    if (this.#dead) return "dead";

    if (this.#landing === null) return "lands";

    if (this.#landing === 0) {
      this.#dead = true;

      return "cut";
    }

    this.#landing -= 1;

    return "lands";
  }

  #at(path: string): string {
    return join(this.#root, ...path.split("/"));
  }

  readonly read: DownloadDisk["read"] = (path) =>
    onDisk("read", path, () => {
      if (this.#dead) throw new Error("killed");

      if (this.#fails(path)) throw new Error("EIO: i/o error, read");

      return existsSync(this.#at(path)) ? readFileSync(this.#at(path), "utf8") : null;
    });

  readonly write: DownloadDisk["write"] = (path, text) =>
    onDisk("write", path, () => {
      const change = this.#change();

      if (change === "dead") throw new Error("killed");
      mkdirSync(dirname(this.#at(path)), { recursive: true });

      if (change === "cut") {
        writeFileSync(this.#at(path), text.slice(0, Math.floor(text.length / 2)));
        throw new Error("killed");
      }

      if (this.full) {
        writeFileSync(this.#at(path), "");
        throw new Error("ENOSPC: no space left on device");
      }

      writeFileSync(this.#at(path), text);
    });

  readonly move: DownloadDisk["move"] = (from, to) =>
    onDisk("move", to, () => {
      if (existsSync(this.#at(to))) {
        if (this.#change() !== "lands") throw new Error("killed");
        rmSync(this.#at(to));
      }

      if (this.#change() !== "lands") throw new Error("killed");
      renameSync(this.#at(from), this.#at(to));
    });

  readonly rename: DownloadDisk["rename"] = (path, name) =>
    onDisk("rename", path, () => {
      const to = join(dirname(this.#at(path)), name);

      if (this.#change() !== "lands") throw new Error("killed");

      if (this.#renamesFail) throw new Error("EIO: i/o error, rename");

      if (!existsSync(this.#at(path))) throw new Error(`ENOENT: no such folder, ${path}`);

      if (existsSync(to)) throw new Error(`EEXIST: ${name} already exists`);
      renameSync(this.#at(path), to);
    });

  readonly remove: DownloadDisk["remove"] = (path) =>
    onDisk("remove", path, () => {
      if (this.#change() !== "lands") throw new Error("killed");
      rmSync(this.#at(path), { recursive: true, force: true });
    });

  readonly list: DownloadDisk["list"] = (path = "") =>
    onDisk("list", path, () => {
      if (this.#dead) throw new Error("killed");

      if (path === "" && this.#listFailures > 0) {
        this.#listFailures -= 1;
        throw new Error("EIO: i/o error, scandir");
      }

      if (!existsSync(this.#at(path))) return null;

      const names = readdirSync(this.#at(path));

      return path === "" ? names.filter((name) => !this.#hidden.has(name)) : names;
    });

  readonly createFolder: DownloadDisk["createFolder"] = (path) =>
    onDisk("createFolder", path, () => {
      if (this.#change() !== "lands") throw new Error("killed");
      mkdirSync(this.#at(path), { recursive: true });
    });

  readonly exists: DownloadDisk["exists"] = (path) => existsSync(this.#at(path));

  readonly uri: DownloadDisk["uri"] = (path) => `file://${this.#at(path)}`;

  readonly fetch: DownloadDisk["fetch"] = () => Promise.resolve(false);

  readonly transfer: DownloadDisk["transfer"] = (): Transfer => {
    throw new Error("NodeDisk starts no transfers.");
  };

  readonly resume: DownloadDisk["resume"] = () => null;

  readonly freeBytes: DownloadDisk["freeBytes"] = () => 64 * 1024 ** 3;
}
