import type { Rectangle } from 'electron';

export function minimumWindowSize(area: Rectangle): [width: number, height: number] {
  return [Math.min(800, area.width), Math.min(540, area.height)];
}

export function fitWindowToWorkArea(area: Rectangle, saved?: Partial<Rectangle>): Rectangle {
  const [minWidth, minHeight] = minimumWindowSize(area);
  const bound = (value: number, min: number, max: number) => Math.max(min, Math.min(Math.round(value), max));
  const width = bound(Number.isFinite(saved?.width) ? saved!.width! : 1440, minWidth, area.width);
  const height = bound(Number.isFinite(saved?.height) ? saved!.height! : 900, minHeight, area.height);
  const x = bound(Number.isFinite(saved?.x) ? saved!.x! : area.x + (area.width - width) / 2, area.x, area.x + area.width - width);
  const y = bound(Number.isFinite(saved?.y) ? saved!.y! : area.y + (area.height - height) / 2, area.y, area.y + area.height - height);
  return { x, y, width, height };
}
