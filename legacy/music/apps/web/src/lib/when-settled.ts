/** How long after the page's load event the deferred work runs if nobody has touched the page. */
const SETTLE_MS = 2000;

const FIRST_INPUT = ["pointerdown", "keydown", "touchstart"] as const;

/**
 * Runs `work` once, on the person's first tap, click, or key press, or two seconds after the page
 * finished loading, whichever is first. For code to fetch ahead of need (dialogs, the error screen)
 * without competing with the first screen's own requests. Returns a function that cancels it.
 */
export const whenSettled = (work: () => void): (() => void) => {
  let done = false;
  let timer: number | undefined;

  const startTimer = () => {
    timer = window.setTimeout(run, SETTLE_MS);
  };

  const cancel = () => {
    done = true;
    window.clearTimeout(timer);
    window.removeEventListener("load", startTimer);

    for (const type of FIRST_INPUT) window.removeEventListener(type, run, { capture: true });
  };

  function run() {
    if (done) return;

    cancel();
    work();
  }

  if (document.readyState === "complete") startTimer();
  else window.addEventListener("load", startTimer, { once: true });

  for (const type of FIRST_INPUT) {
    window.addEventListener(type, run, { capture: true, passive: true });
  }

  return cancel;
};
