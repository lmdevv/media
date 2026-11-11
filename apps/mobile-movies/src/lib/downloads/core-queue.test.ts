import { describe, expect, it } from "vitest";

import { coreQueue } from "./core-queue";

const deferred = () => Promise.withResolvers<void>();

describe("coreQueue", () => {
  it("lands a remove sent straight after a download starts after its add", async () => {
    const queue = coreQueue();
    const events: Array<string> = [];
    const addAnswers = deferred();

    const add = queue.run("file-1", async () => {
      events.push("add sent");
      await addAnswers.promise;
      events.push("add landed");
    });

    // Cancel at once, while the add is still in flight.
    const remove = queue.run("file-1", async () => {
      events.push("remove sent");
    });

    await Promise.resolve();
    expect(events).toEqual(["add sent"]);

    addAnswers.resolve();
    await Promise.all([add, remove]);

    expect(events).toEqual(["add sent", "add landed", "remove sent"]);
  });

  it("runs calls about different items side by side", async () => {
    const queue = coreQueue();
    const events: Array<string> = [];
    const slow = deferred();

    const first = queue.run("file-1", async () => {
      await slow.promise;
      events.push("file-1");
    });

    await queue.run("file-2", async () => {
      events.push("file-2");
    });
    slow.resolve();
    await first;

    expect(events).toEqual(["file-2", "file-1"]);
  });

  it("runs the next call after one that failed, and passes the failure to its caller", async () => {
    const queue = coreQueue();

    const failed = queue.run("file-1", async () => {
      throw new Error("refused");
    });

    await expect(failed).rejects.toThrow("refused");
    await expect(queue.run("file-1", async () => "removed")).resolves.toBe("removed");
  });
});
