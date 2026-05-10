import Phaser from 'phaser';
import type { CollisionZone } from '../constants';
import { CANVAS_WIDTH, CANVAS_HEIGHT, DOOR_X, DOOR_Y, FLOOR_START_Y } from '../constants';
import {
  DYNAMIC_BLOCK_RADIUS_CELLS,
  NAVIGATION_CLEARANCE_CELLS,
  NAVIGATION_PADDING_PX,
  PATHFINDING_CELL,
} from './Config';

export interface PathPoint {
  x: number;
  y: number;
}

interface GridNode {
  x: number;
  y: number;
  g: number;
  h: number;
  f: number;
  parent: GridNode | null;
}

interface SearchContext {
  sx: number;
  sy: number;
}

interface FindPathOptions {
  goalRadius?: number;
  allowNearest?: boolean;
  preciseDestination?: boolean;
}

export interface PathDebugGrid {
  cols: number;
  rows: number;
  cell: number;
  cells: Uint8Array;
}

const CELL = PATHFINDING_CELL;
const COLS = Math.floor(CANVAS_WIDTH / CELL);
const ROWS = Math.floor(CANVAS_HEIGHT / CELL);
const WALL_FLOOR_Y = Math.floor(FLOOR_START_Y / CELL);
const INF = 1_000_000;

const DIRS: [number, number, number][] = [
  [1, 0, 10], [-1, 0, 10], [0, 1, 10], [0, -1, 10],
  [1, 1, 14], [-1, 1, 14], [1, -1, 14], [-1, -1, 14],
];

let staticGrid = new Uint8Array(COLS * ROWS);
let dynamicGrid = new Uint8Array(COLS * ROWS);
let costGrid = new Uint8Array(COLS * ROWS);
let initialized = false;

function idx(x: number, y: number): number {
  return y * COLS + x;
}

function inBounds(x: number, y: number): boolean {
  return x >= 0 && x < COLS && y >= 0 && y < ROWS;
}

function cellCenter(x: number, y: number): PathPoint {
  return { x: x * CELL + CELL / 2, y: y * CELL + CELL / 2 };
}

function pixelToCell(value: number, maxCells: number): number {
  return Math.max(0, Math.min(maxCells - 1, Math.floor(value / CELL)));
}

function overlapsPaddedZone(
  cl: number,
  cr: number,
  ct: number,
  cb: number,
  zone: CollisionZone,
): boolean {
  return (
    cl < zone.x + zone.halfW + NAVIGATION_PADDING_PX &&
    cr > zone.x - zone.halfW - NAVIGATION_PADDING_PX &&
    cb > zone.y - zone.halfH - NAVIGATION_PADDING_PX &&
    ct < zone.y + zone.halfH + NAVIGATION_PADDING_PX
  );
}

function isDoorCell(x: number, y: number): boolean {
  const doorGx = Math.round(DOOR_X / CELL);
  const doorGy = Math.round(DOOR_Y / CELL);
  return Math.abs(x - doorGx) <= 2 && Math.abs(y - doorGy) <= 2;
}

export function initPathfindingGrid(collisionZones: CollisionZone[]) {
  staticGrid = new Uint8Array(COLS * ROWS);
  dynamicGrid = new Uint8Array(COLS * ROWS);
  costGrid = new Uint8Array(COLS * ROWS);

  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const i = idx(x, y);
      const cl = x * CELL;
      const cr = cl + CELL;
      const ct = y * CELL;
      const cb = ct + CELL;

      if (y < WALL_FLOOR_Y && !isDoorCell(x, y)) {
        staticGrid[i] = 1;
        continue;
      }

      for (const zone of collisionZones) {
        if (overlapsPaddedZone(cl, cr, ct, cb, zone)) {
          staticGrid[i] = 1;
          break;
        }
      }
    }
  }

  buildClearanceCost();
  initialized = true;
}

function buildClearanceCost() {
  const blocked: [number, number][] = [];
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      if (staticGrid[idx(x, y)]) blocked.push([x, y]);
    }
  }

  for (const [bx, by] of blocked) {
    for (let dy = -NAVIGATION_CLEARANCE_CELLS; dy <= NAVIGATION_CLEARANCE_CELLS; dy++) {
      for (let dx = -NAVIGATION_CLEARANCE_CELLS; dx <= NAVIGATION_CLEARANCE_CELLS; dx++) {
        const x = bx + dx;
        const y = by + dy;
        if (!inBounds(x, y)) continue;
        const i = idx(x, y);
        if (staticGrid[i]) continue;
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const cost = dist === 0 ? 0 : NAVIGATION_CLEARANCE_CELLS - dist + 1;
        costGrid[i] = Math.max(costGrid[i], cost);
      }
    }
  }
}

export function blockCell(px: number, py: number, radiusCells = DYNAMIC_BLOCK_RADIUS_CELLS) {
  const cx = Math.floor(px / CELL);
  const cy = Math.floor(py / CELL);
  for (let dy = -radiusCells; dy <= radiusCells; dy++) {
    for (let dx = -radiusCells; dx <= radiusCells; dx++) {
      if (Math.hypot(dx, dy) > radiusCells + 0.15) continue;
      const x = cx + dx;
      const y = cy + dy;
      if (!inBounds(x, y)) continue;
      const i = idx(x, y);
      if (!staticGrid[i]) dynamicGrid[i] = 1;
    }
  }
}

export function clearDynamicBlocks() {
  dynamicGrid.fill(0);
}

function isStaticBlocked(x: number, y: number): boolean {
  if (!inBounds(x, y)) return true;
  return staticGrid[idx(x, y)] === 1;
}

function isHardBlocked(x: number, y: number, ctx?: SearchContext): boolean {
  if (!inBounds(x, y)) return true;
  const i = idx(x, y);
  if (staticGrid[i]) return true;
  if (ctx && Math.max(Math.abs(x - ctx.sx), Math.abs(y - ctx.sy)) <= 1) return false;
  return dynamicGrid[i] === 1;
}

function traversalCost(x: number, y: number, ctx: SearchContext): number {
  const i = idx(x, y);
  let cost = costGrid[i] * 6;

  if (!dynamicGrid[i]) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (!inBounds(nx, ny)) continue;
        if (Math.max(Math.abs(nx - ctx.sx), Math.abs(ny - ctx.sy)) <= 1) continue;
        if (dynamicGrid[idx(nx, ny)]) cost += 8;
      }
    }
  }

  return cost;
}

function octile(x1: number, y1: number, x2: number, y2: number): number {
  const dx = Math.abs(x1 - x2);
  const dy = Math.abs(y1 - y2);
  return 10 * (dx + dy) + (14 - 20) * Math.min(dx, dy);
}

function neighbors(node: GridNode, ctx: SearchContext): [number, number, number][] {
  const result: [number, number, number][] = [];

  for (const [dx, dy, baseCost] of DIRS) {
    const nx = node.x + dx;
    const ny = node.y + dy;
    if (isHardBlocked(nx, ny, ctx)) continue;

    if (dx !== 0 && dy !== 0) {
      if (isHardBlocked(node.x + dx, node.y, ctx) || isHardBlocked(node.x, node.y + dy, ctx)) {
        continue;
      }
    }

    result.push([nx, ny, baseCost + traversalCost(nx, ny, ctx)]);
  }

  return result;
}

function runAStar(
  sx: number,
  sy: number,
  gx: number,
  gy: number,
  goalRadius: number,
): PathPoint[] | null {
  const ctx: SearchContext = { sx, sy };
  const open: Map<number, GridNode> = new Map();
  const closed = new Uint8Array(COLS * ROWS);

  const start: GridNode = {
    x: sx,
    y: sy,
    g: 0,
    h: octile(sx, sy, gx, gy),
    f: 0,
    parent: null,
  };
  start.f = start.h;
  open.set(idx(sx, sy), start);

  while (open.size > 0) {
    let current: GridNode | null = null;
    for (const node of open.values()) {
      if (!current || node.f < current.f || (node.f === current.f && node.h < current.h)) {
        current = node;
      }
    }
    if (!current) break;

    const ck = idx(current.x, current.y);
    open.delete(ck);
    if (closed[ck]) continue;

    if (Math.max(Math.abs(current.x - gx), Math.abs(current.y - gy)) <= goalRadius) {
      const path: PathPoint[] = [];
      let node: GridNode | null = current;
      while (node) {
        path.push(cellCenter(node.x, node.y));
        node = node.parent;
      }
      return path.reverse();
    }

    closed[ck] = 1;

    for (const [nx, ny, stepCost] of neighbors(current, ctx)) {
      const nk = idx(nx, ny);
      if (closed[nk]) continue;

      const g = current.g + stepCost;
      const existing = open.get(nk);
      if (existing && g >= existing.g) continue;

      const h = octile(nx, ny, gx, gy);
      open.set(nk, {
        x: nx,
        y: ny,
        g,
        h,
        f: g + h,
        parent: current,
      });
    }
  }

  return null;
}

function findNearestFreeCells(gx: number, gy: number, maxRadius: number): { x: number; y: number; score: number }[] {
  const cells: { x: number; y: number; score: number }[] = [];

  for (let r = 0; r <= maxRadius; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = gx + dx;
        const y = gy + dy;
        if (!inBounds(x, y)) continue;
        if (isStaticBlocked(x, y) || dynamicGrid[idx(x, y)]) continue;
        const i = idx(x, y);
        cells.push({ x, y, score: r * 20 + costGrid[i] * 4 + Math.abs(dx) + Math.abs(dy) });
      }
    }
    if (cells.length >= 10) break;
  }

  return cells.sort((a, b) => a.score - b.score);
}

function nearestFreeStart(sx: number, sy: number): { x: number; y: number } {
  if (!isStaticBlocked(sx, sy)) return { x: sx, y: sy };

  const options = findNearestFreeCells(sx, sy, 6);
  return options[0] ?? { x: sx, y: sy };
}

function lineOfSight(a: PathPoint, b: PathPoint, ctx: SearchContext): boolean {
  const dist = Phaser.Math.Distance.Between(a.x, a.y, b.x, b.y);
  const steps = Math.max(1, Math.ceil(dist / (CELL * 0.5)));

  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const x = pixelToCell(Phaser.Math.Linear(a.x, b.x, t), COLS);
    const y = pixelToCell(Phaser.Math.Linear(a.y, b.y, t), ROWS);
    if (isHardBlocked(x, y, ctx)) return false;
  }

  return true;
}

function smoothPath(path: PathPoint[], ctx: SearchContext): PathPoint[] {
  if (path.length <= 2) return path;

  const result: PathPoint[] = [path[0]];
  let anchor = 0;

  while (anchor < path.length - 1) {
    let next = path.length - 1;
    for (; next > anchor + 1; next--) {
      if (lineOfSight(path[anchor], path[next], ctx)) break;
    }
    result.push(path[next]);
    anchor = next;
  }

  return result;
}

function trimStart(path: PathPoint[], fromX: number, fromY: number): PathPoint[] {
  while (path.length > 1 && Phaser.Math.Distance.Between(fromX, fromY, path[0].x, path[0].y) < CELL * 0.75) {
    path.shift();
  }
  return path;
}

export function findPath(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  options: FindPathOptions = {},
): PathPoint[] | null {
  if (!initialized) return null;

  const start = nearestFreeStart(pixelToCell(fromX, COLS), pixelToCell(fromY, ROWS));
  const goalX = pixelToCell(toX, COLS);
  const goalY = pixelToCell(toY, ROWS);
  const goalRadius = Math.max(0, Math.floor((options.goalRadius ?? 0) / CELL));
  const allowNearest = options.allowNearest ?? true;
  const preciseDestination = options.preciseDestination ?? true;
  const startCtx: SearchContext = { sx: start.x, sy: start.y };
  const goals = isHardBlocked(goalX, goalY, startCtx) && allowNearest
    ? findNearestFreeCells(goalX, goalY, 10)
    : [{ x: goalX, y: goalY, score: 0 }];

  if (goals.length === 0) return null;

  let best: { path: PathPoint[]; goal: { x: number; y: number } } | null = null;
  let bestScore = INF;

  for (const goal of goals.slice(0, 12)) {
    if (isHardBlocked(goal.x, goal.y, startCtx)) continue;
    const path = runAStar(start.x, start.y, goal.x, goal.y, goalRadius);
    if (!path) continue;

    const end = path[path.length - 1];
    const score = Phaser.Math.Distance.Between(end.x, end.y, toX, toY) + path.length * CELL * 0.15;
    if (score < bestScore) {
      bestScore = score;
      best = { path, goal };
    }
  }

  if (!best) return null;

  const ctx = { sx: start.x, sy: start.y };
  let path = smoothPath(best.path, ctx);
  path = trimStart(path, fromX, fromY);

  const destination: PathPoint = { x: toX, y: toY };
  const goalWasExact = best.goal.x === goalX && best.goal.y === goalY;
  const last = path[path.length - 1];
  if (
    preciseDestination &&
    goalWasExact &&
    last &&
    Phaser.Math.Distance.Between(last.x, last.y, toX, toY) > 2 &&
    lineOfSight(last, destination, ctx)
  ) {
    path.push(destination);
  }

  return path.length > 0 ? path : [destination];
}

export function getPathfindingDebugGrid(): PathDebugGrid {
  const cells = new Uint8Array(COLS * ROWS);
  for (let i = 0; i < cells.length; i++) {
    if (staticGrid[i]) cells[i] = 1;
    else if (dynamicGrid[i]) cells[i] = 2;
    else if (costGrid[i] > 0) cells[i] = 3;
  }

  return {
    cols: COLS,
    rows: ROWS,
    cell: CELL,
    cells,
  };
}
