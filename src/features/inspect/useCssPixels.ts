import { useEffect, useState } from 'react';

function read(name: string, fallback: number): number {
  const value = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** A pixel token (`--blame-row-height`) as a number, re-read when the density changes. */
export function useCssPixels(name: string, fallback: number): number {
  const [value, setValue] = useState(() => read(name, fallback));
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setValue(read(name, fallback));
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-density', 'style'],
    });
    return () => {
      observer.disconnect();
    };
  }, [name, fallback]);
  return value;
}
