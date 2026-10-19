import type { Locator, Page } from '@playwright/test';

/**
 * An invisible box laid over the union of `parts`, to crop several elements that share no
 * container (a popover and the toolbar button it opens from).
 */
export async function around(page: Page, parts: Locator[]): Promise<Locator> {
  const boxes = await Promise.all(parts.map((part) => part.boundingBox()));
  const visible = boxes.filter((box) => box !== null);
  if (visible.length !== parts.length) throw new Error('crop part not visible');
  const left = Math.min(...visible.map((box) => box.x));
  const top = Math.min(...visible.map((box) => box.y));
  const right = Math.max(...visible.map((box) => box.x + box.width));
  const bottom = Math.max(...visible.map((box) => box.y + box.height));
  await page.evaluate(
    ({ left, top, width, height }) => {
      const box = document.createElement('div');
      box.id = 'docs-crop';
      Object.assign(box.style, {
        position: 'fixed',
        left: `${left}px`,
        top: `${top}px`,
        width: `${width}px`,
        height: `${height}px`,
        pointerEvents: 'none',
      });
      document.body.append(box);
    },
    { left, top, width: right - left, height: bottom - top },
  );
  return page.locator('#docs-crop');
}
