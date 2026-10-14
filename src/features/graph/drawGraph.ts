import { EDGE_WIDTH, NODE_RADIUS } from './geometry';
import type { GraphScene, Segment } from './scene';

/** Colors read from the theme tokens (`--lane-n`, surfaces). */
export interface GraphPalette {
  lanes: string[];
  background: string;
  selected: string;
}

/** Subset of `CanvasRenderingContext2D` used, so tests can record the calls. */
export type GraphContext = Pick<
  CanvasRenderingContext2D,
  | 'beginPath'
  | 'moveTo'
  | 'lineTo'
  | 'bezierCurveTo'
  | 'arc'
  | 'rect'
  | 'stroke'
  | 'fill'
  | 'setLineDash'
  | 'clearRect'
  | 'strokeStyle'
  | 'fillStyle'
  | 'lineWidth'
  | 'globalAlpha'
  | 'lineCap'
>;

function laneColor(palette: GraphPalette, color: number): string {
  return palette.lanes[color % palette.lanes.length] ?? palette.lanes[0] ?? palette.background;
}

function tracePath(ctx: GraphContext, s: Segment): void {
  ctx.moveTo(s.x1, s.y1);
  if (s.x1 === s.x2) {
    ctx.lineTo(s.x2, s.y2);
    return;
  }
  // Same curve as the mockups: the lane change happens over one row height.
  const mid = (s.y2 - s.y1) / 2;
  ctx.bezierCurveTo(s.x1, s.y1 + mid, s.x2, s.y2 - mid, s.x2, s.y2);
}

/**
 * Draws a scene. Lines are batched by color and style (one `stroke` per batch), then nodes
 * on top, so a frame costs a handful of draw calls whatever the number of rows.
 */
export function drawScene(
  ctx: GraphContext,
  scene: GraphScene,
  palette: GraphPalette,
  width: number,
  height: number,
): void {
  ctx.clearRect(0, 0, width, height);
  ctx.lineWidth = EDGE_WIDTH;
  ctx.lineCap = 'round';

  const batches = new Map<string, Segment[]>();
  for (const segment of scene.segments) {
    const key = `${String(segment.color)}:${segment.dashed ? 'd' : 's'}`;
    const batch = batches.get(key);
    if (batch) batch.push(segment);
    else batches.set(key, [segment]);
  }
  for (const [key, segments] of batches) {
    const first = segments[0];
    if (!first) continue;
    ctx.setLineDash(key.endsWith('d') ? [3, 3] : []);
    ctx.strokeStyle = laneColor(palette, first.color);
    ctx.beginPath();
    for (const segment of segments) tracePath(ctx, segment);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  for (const node of scene.nodes) {
    const color = laneColor(palette, node.color);
    const ring = node.selected ? palette.selected : palette.background;
    if (node.kind === 'wip') {
      ctx.fillStyle = ring;
      ctx.beginPath();
      ctx.arc(node.x, node.y, NODE_RADIUS, 0, Math.PI * 2);
      ctx.fill();
      ctx.setLineDash([2.5, 2]);
      ctx.strokeStyle = color;
      ctx.lineWidth = EDGE_WIDTH;
      ctx.stroke();
      ctx.setLineDash([]);
      continue;
    }
    if (node.head) {
      ctx.globalAlpha = 0.55;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(node.x, node.y, NODE_RADIUS + 3, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    const radius = node.kind === 'merge' ? NODE_RADIUS - 1.5 : NODE_RADIUS;
    ctx.fillStyle = color;
    ctx.strokeStyle = ring;
    ctx.lineWidth = EDGE_WIDTH;
    ctx.beginPath();
    ctx.arc(node.x, node.y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
}
