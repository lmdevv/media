import { useEffect, useState, useSyncExternalStore } from "react";

/** Each watched element's handler, all on one observer. */
const watched = new WeakMap<Element, (cssPixels: number) => void>();

let observer: ResizeObserver | null = null;

const resizes = (): ResizeObserver => {
  observer ??= new ResizeObserver((entries) => {
    for (const entry of entries) {
      const box = entry.borderBoxSize[0];

      if (box !== undefined) watched.get(entry.target)?.(Math.max(box.inlineSize, box.blockSize));
    }
  });

  return observer;
};

/** Calls `onChange` when the screen's pixel density changes, such as on zoom or a new display. */
const subscribeToDensity = (onChange: () => void): (() => void) => {
  let query = window.matchMedia(`(resolution: ${String(window.devicePixelRatio)}dppx)`);

  const changed = () => {
    query.removeEventListener("change", changed);
    query = window.matchMedia(`(resolution: ${String(window.devicePixelRatio)}dppx)`);
    query.addEventListener("change", changed);
    onChange();
  };

  query.addEventListener("change", changed);

  return () => query.removeEventListener("change", changed);
};

const density = (): number => window.devicePixelRatio;

/**
 * The size in device pixels an element is drawn at: the longer side of its layout box, without
 * transforms, times the screen's pixel density, kept current as either changes. Null until the
 * element is laid out. Pass the returned callback as the element's `ref`.
 */
export const useDrawnPixels = (): readonly [(element: Element | null) => void, number | null] => {
  const [element, setElement] = useState<Element | null>(null);
  const [cssPixels, setCssPixels] = useState<number | null>(null);
  const ratio = useSyncExternalStore(subscribeToDensity, density);

  useEffect(() => {
    if (element === null) return undefined;

    watched.set(element, setCssPixels);
    resizes().observe(element);

    return () => {
      resizes().unobserve(element);
      watched.delete(element);
    };
  }, [element]);

  return [setElement, cssPixels === null ? null : cssPixels * ratio];
};
