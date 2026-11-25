import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { onDisk } from "./disk";
import type { DownloadDisk, Transfer } from "./disk";

/** What the app's next file change does once a test has set it to die. */
type Change = "lands" | "cut" | "dead";

/**
 * A downloads folder in a directory on this computer, which a test can kill or fill up the way a
 * phone's can. A write cut short by a kill leaves the first half of its text, as a native write
 * does; a write to a full disk leaves its file empty. Once killed, nothing more reaches the disk.
 * It starts no transfers.
 */
export class NodeDisk implements DownloadDisk {
  readonly #root: string;
  /** File changes that still land before the app dies during the next; null never dies. */
  #landing: number | null = null;
  #dead = false;
  /** Whether writes run out of space. */
  full = false;

  constructor(root: string) {
    this.#root = root;
  }

  /** Kills the app during its `nth` file change from now, 1 being the next. */
  killAt(nth: number): void {
    this.#landing = nth - 1;
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

  readonly remove: DownloadDisk["remove"] = (path) =>
    onDisk("remove", path, () => {
      if (this.#change() !== "lands") throw new Error("killed");
      rmSync(this.#at(path), { recursive: true, force: true });
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
