'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { PenLine, Eraser, Undo2, Trash2, Check, X, Square, AlignJustify, Grid3x3, Grip, ZoomIn, ZoomOut, Maximize, Minimize, Hand } from 'lucide-react';

type Point = { x: number, y: number, pressure: number };
type Stroke = { color: string, size: number, points: Point[] };
type Paper = 'blank' | 'lined' | 'grid' | 'dots';
// Page coordinates map to the screen as screen = page * scale + (x, y)
type View = { scale: number, x: number, y: number };
// What a node keeps so its drawing can be reopened as live strokes: the strokes and paper, the image
// they were drawn over (and where), and the PNG they were saved as (if the node's image no longer
// matches it, the drawing was replaced and is stale)
export type SavedDrawing = {
  strokes: Stroke[],
  paper: Paper,
  base?: string,
  baseRect?: { x: number, y: number, w: number, h: number },
  image: string
};

const COLORS = ['#f8fafc', '#ef4444', '#3b82f6', '#10b981', '#fbbf24'];
const BACKGROUND = '#0f172a';
const PADDING = 16;
const ERASER_RADIUS = 12;
// Two quick pencil taps on the same spot toggle pen / eraser. Kept strict so writing dots
// (i, j, colons, full stops) doesn't trigger it by accident.
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_DIST = 12;
const TAP_MS = 150;
// Holding still this long at the end of a stroke snaps it to a clean shape
const HOLD_MS = 350;
const HOLD_TOLERANCE = 10;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 5;
const PAPER_GAP = 32;
const PAPER_LINE = 'rgba(148, 163, 184, 0.22)';
const PAPERS: { id: Paper, title: string, Icon: typeof Square }[] = [
  { id: 'blank', title: 'Blank paper', Icon: Square },
  { id: 'lined', title: 'Lined paper', Icon: AlignJustify },
  { id: 'grid', title: 'Grid paper', Icon: Grid3x3 },
  { id: 'dots', title: 'Dotted paper', Icon: Grip }
];
const PAPER_KEY = 'drawpad-paper';
const PEN_SIZE_KEY = 'drawpad-pen-size';
const MIN_PEN = 1;
const MAX_PEN = 20;

// The paper's lines, grid or dots over the page area left..right, top..bottom (lined to page coordinates,
// so they stay put under the drawing when zooming and panning)
const drawPaper = (ctx: CanvasRenderingContext2D, paper: Paper, left: number, top: number, right: number, bottom: number, scale: number) => {
  if (paper === 'blank') return;
  const first = (v: number) => Math.floor(v / PAPER_GAP) * PAPER_GAP;
  ctx.save();
  ctx.strokeStyle = PAPER_LINE;
  ctx.fillStyle = PAPER_LINE;
  ctx.lineWidth = 1 / scale;
  ctx.beginPath();
  if (paper === 'dots') {
    const radius = Math.max(1.2, 1 / scale);
    for (let x = first(left); x <= right; x += PAPER_GAP) for (let y = first(top); y <= bottom; y += PAPER_GAP) {
      ctx.moveTo(x + radius, y);
      ctx.arc(x, y, radius, 0, Math.PI * 2);
    }
    ctx.fill();
  } else {
    for (let y = first(top); y <= bottom; y += PAPER_GAP) { ctx.moveTo(left, y); ctx.lineTo(right, y); }
    if (paper === 'grid') for (let x = first(left); x <= right; x += PAPER_GAP) { ctx.moveTo(x, top); ctx.lineTo(x, bottom); }
    ctx.stroke();
  }
  ctx.restore();
};

// Distance from point p to the segment a-b
const distToSegment = (p: Point, a: Point, b: Point) => {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
};

const strokeHit = (s: Stroke, p: Point, radius = ERASER_RADIUS) => {
  const reach = radius + s.size;
  if (s.points.length === 1) return Math.hypot(p.x - s.points[0].x, p.y - s.points[0].y) <= reach;
  for (let i = 1; i < s.points.length; i++) if (distToSegment(p, s.points[i - 1], s.points[i]) <= reach) return true;
  return false;
};

// A scribble (scratch-out): a back-and-forth zigzag, much longer than the area it covers.
// Circles and spirals (even drawn several times round) turn mostly one way, so they don't count.
const isScribble = (s: Stroke) => {
  const sampled: Point[] = [];
  for (const p of s.points) {
    const last = sampled[sampled.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) >= 8) sampled.push(p);
  }
  if (sampled.length < 8) return false;
  let length = 0, reversals = 0, turning = 0, absTurning = 0;
  for (let i = 1; i < sampled.length; i++) {
    length += Math.hypot(sampled[i].x - sampled[i - 1].x, sampled[i].y - sampled[i - 1].y);
    if (i < 2) continue;
    const ax = sampled[i - 1].x - sampled[i - 2].x, ay = sampled[i - 1].y - sampled[i - 2].y;
    const bx = sampled[i].x - sampled[i - 1].x, by = sampled[i].y - sampled[i - 1].y;
    // A turn sharper than 120 degrees
    if ((ax * bx + ay * by) / (Math.hypot(ax, ay) * Math.hypot(bx, by)) < -0.5) reversals++;
    const angle = Math.atan2(ax * by - ay * bx, ax * bx + ay * by);
    turning += angle;
    absTurning += Math.abs(angle);
  }
  // Most of the turning in one direction: a loop, not a zigzag
  if (absTurning > 0 && Math.abs(turning) > 0.5 * absTurning) return false;
  const xs = sampled.map(p => p.x), ys = sampled.map(p => p.y);
  const diagonal = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  return reversals >= 4 && length >= 3 * diagonal;
};

// Points spaced at least `gap` apart, so fits aren't skewed by where the pen slowed down
const resample = (pts: Point[], gap = 8) => {
  const out = [pts[0]];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (Math.hypot(p.x - last.x, p.y - last.y) >= gap) out.push(p);
  }
  return out;
};

// Ramer-Douglas-Peucker: the few points that keep the path within `epsilon` of the original
const simplify = (pts: Point[], epsilon: number): Point[] => {
  if (pts.length < 3) return pts;
  let maxDist = 0, index = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = distToSegment(pts[i], pts[0], pts[pts.length - 1]);
    if (d > maxDist) { maxDist = d; index = i; }
  }
  if (maxDist <= epsilon) return [pts[0], pts[pts.length - 1]];
  return [...simplify(pts.slice(0, index + 1), epsilon).slice(0, -1), ...simplify(pts.slice(index), epsilon)];
};

// Dense points along a polyline, so a snapped shape draws like any other stroke
const tracePolyline = (corners: { x: number, y: number }[], pressure: number) => {
  const out: Point[] = [];
  for (let i = 1; i < corners.length; i++) {
    const a = corners[i - 1], b = corners[i];
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 3));
    for (let k = i === 1 ? 0 : 1; k <= steps; k++) {
      out.push({ x: a.x + (b.x - a.x) * k / steps, y: a.y + (b.y - a.y) * k / steps, pressure });
    }
  }
  return out;
};

// A held stroke that's roughly straight, as the two ends of a clean line, or null.
// The direction comes from a best fit through all the points, so a hook where the pen landed or a
// slight bow doesn't throw it off; then it snaps to horizontal, vertical or 45° when close to one.
const ANGLE_SNAP = (15 * Math.PI) / 180;
const fitLine = (pts: Point[], length: number) => {
  const start = pts[0], end = pts[pts.length - 1];
  const chord = Math.hypot(end.x - start.x, end.y - start.y);
  if (chord < 25 || chord < 0.45 * length) return null;
  const cx = pts.reduce((a, p) => a + p.x, 0) / pts.length, cy = pts.reduce((a, p) => a + p.y, 0) / pts.length;
  let sxx = 0, syy = 0, sxy = 0;
  for (const p of pts) { sxx += (p.x - cx) ** 2; syy += (p.y - cy) ** 2; sxy += (p.x - cx) * (p.y - cy); }
  let angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  // Point it from the start towards the end
  if ((end.x - start.x) * Math.cos(angle) + (end.y - start.y) * Math.sin(angle) < 0) angle += Math.PI;
  const off = (p: Point) => Math.abs(-(p.x - cx) * Math.sin(angle) + (p.y - cy) * Math.cos(angle));
  // Judge straightness on the middle of the stroke, ignoring hooks at either end
  const trim = Math.floor(pts.length * 0.2);
  const middle = pts.slice(trim, pts.length - trim);
  const rms = Math.sqrt(middle.reduce((a, p) => a + off(p) ** 2, 0) / middle.length);
  if (rms > Math.max(12, 0.16 * chord) || Math.max(...middle.map(off)) > Math.max(25, 0.3 * chord)) return null;

  // Run it through the middle of where the pen started and ended, not the bow's centre
  const mx = (start.x + end.x) / 2, my = (start.y + end.y) / 2;
  const along = (p: Point) => (p.x - mx) * Math.cos(angle) + (p.y - my) * Math.sin(angle);
  const t0 = along(start), t1 = along(end);
  const quarter = Math.PI / 4;
  const snapped = Math.round(angle / quarter) * quarter;
  if (Math.abs(angle - snapped) < ANGLE_SNAP) {
    // Same middle and length, turned onto the exact angle
    return [t0, t1].map(t => ({ x: mx + t * Math.cos(snapped), y: my + t * Math.sin(snapped) }));
  }
  return [t0, t1].map(t => ({ x: mx + t * Math.cos(angle), y: my + t * Math.sin(angle) }));
};

// The cleaned-up version of a held stroke: a straight line, a circle or ellipse, a triangle or a
// rectangle, or null when it doesn't look like any of them
const recognizeShape = (stroke: Stroke): Point[] | null => {
  const pts = resample(stroke.points);
  if (pts.length < 5) return null;
  const pressures = stroke.points.map(p => p.pressure).sort((a, b) => a - b);
  const pressure = pressures[Math.floor(pressures.length / 2)];
  const start = pts[0], end = pts[pts.length - 1];
  let length = 0;
  for (let i = 1; i < pts.length; i++) length += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  if (length < 30) return null;
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  const size = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));

  const line = fitLine(pts, length);
  if (line) return tracePolyline(line, pressure);

  // Everything else has to come back round to where it started
  if (Math.hypot(end.x - start.x, end.y - start.y) > Math.max(25, 0.25 * size)) return null;
  const tolerance = Math.max(6, 0.08 * size);

  // Ellipse: centre and axes from the points' spread (for an ellipse, variance along an axis = radius² / 2)
  const cx = xs.reduce((a, b) => a + b, 0) / pts.length, cy = ys.reduce((a, b) => a + b, 0) / pts.length;
  let sxx = 0, syy = 0, sxy = 0;
  for (const p of pts) { sxx += (p.x - cx) ** 2; syy += (p.y - cy) ** 2; sxy += (p.x - cx) * (p.y - cy); }
  sxx /= pts.length; syy /= pts.length; sxy /= pts.length;
  const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const spread = Math.sqrt(((sxx - syy) / 2) ** 2 + sxy ** 2);
  let ra = Math.sqrt(2 * ((sxx + syy) / 2 + spread)), rb = Math.sqrt(2 * Math.max(0, (sxx + syy) / 2 - spread));
  // Nearly round: make it a true circle
  if (rb > 0.85 * ra) ra = rb = pts.reduce((sum, p) => sum + Math.hypot(p.x - cx, p.y - cy), 0) / pts.length;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const ellipseError = rb < 4 ? Infinity : pts.reduce((sum, p) => {
    const u = (p.x - cx) * cos + (p.y - cy) * sin, v = -(p.x - cx) * sin + (p.y - cy) * cos;
    return sum + Math.abs(Math.hypot(u / ra, v / rb) - 1) * (ra + rb) / 2;
  }, 0) / pts.length;

  // Polygon: the corners left after simplifying, minus any that are really just a straight edge
  let corners = simplify([...pts, start], 0.05 * length).slice(0, -1);
  const turn = (a: Point, b: Point, c: Point) => {
    const ux = b.x - a.x, uy = b.y - a.y, vx = c.x - b.x, vy = c.y - b.y;
    return Math.abs(Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy));
  };
  for (let changed = true; changed && corners.length > 3;) {
    changed = false;
    for (let i = 0; i < corners.length; i++) {
      const n = corners.length;
      if (turn(corners[(i + n - 1) % n], corners[i], corners[(i + 1) % n]) < 0.45) {
        corners = corners.filter((_, j) => j !== i);
        changed = true;
        break;
      }
    }
  }
  let polygon: { x: number, y: number }[] | null = null;
  if (corners.length === 3 || corners.length === 4) {
    polygon = corners;
    // A rectangle drawn roughly level becomes an exact, level one
    if (corners.length === 4) {
      const level = corners.every((c, i) => {
        const d = corners[(i + 1) % 4];
        const a = Math.abs(Math.atan2(d.y - c.y, d.x - c.x)) % (Math.PI / 2);
        return Math.min(a, Math.PI / 2 - a) < 0.2;
      });
      if (level) {
        const l = Math.min(...corners.map(c => c.x)), r = Math.max(...corners.map(c => c.x));
        const t = Math.min(...corners.map(c => c.y)), b = Math.max(...corners.map(c => c.y));
        polygon = [{ x: l, y: t }, { x: r, y: t }, { x: r, y: b }, { x: l, y: b }];
      }
    }
  }
  const polygonError = polygon ? pts.reduce((sum, p) => {
    let d = Infinity;
    for (let i = 0; i < polygon!.length; i++) {
      const a = polygon![i], b = polygon![(i + 1) % polygon!.length];
      d = Math.min(d, distToSegment(p, { ...a, pressure: 0 }, { ...b, pressure: 0 }));
    }
    return sum + d;
  }, 0) / pts.length : Infinity;

  if (Math.min(ellipseError, polygonError) > tolerance) return null;
  if (polygon && polygonError < ellipseError) return tracePolyline([...polygon, polygon[0]], pressure);
  const steps = Math.max(24, Math.ceil(Math.PI * (ra + rb) / 3));
  const ring: Point[] = [];
  for (let k = 0; k <= steps; k++) {
    const t = (k / steps) * Math.PI * 2;
    const u = ra * Math.cos(t), v = rb * Math.sin(t);
    ring.push({ x: cx + u * cos - v * sin, y: cy + u * sin + v * cos, pressure });
  }
  return ring;
};

// The strokes a scribble crosses out: touched by it and mostly inside the area it covers
const scribbledOut = (scribble: Stroke, strokes: Stroke[]) => {
  const xs = scribble.points.map(p => p.x), ys = scribble.points.map(p => p.y);
  const minX = Math.min(...xs) - 6, maxX = Math.max(...xs) + 6, minY = Math.min(...ys) - 6, maxY = Math.max(...ys) + 6;
  return strokes.filter(st => {
    const inside = st.points.filter(p => p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY).length;
    if (inside < 0.4 * st.points.length) return false;
    return scribble.points.some(p => strokeHit(st, p, scribble.size + 4));
  });
};

// Free drawing for a node, on a full-screen canvas: Apple Pencil or mouse, and a finger only when
// finger drawing is switched on (so a resting palm doesn't draw).
// The eraser removes whole strokes it touches and switches back to the pen when lifted; a quick double
// tap of the pencil tip switches to it. Scribbling over strokes with the pen also erases them.
// Holding the pen still at the end of a stroke snaps it to a straight line, circle, triangle or rectangle.
// Two fingers pinch to zoom and drag to pan, and with finger drawing off one finger pans too
// (also ctrl/⌘+wheel or a trackpad pinch to zoom, wheel to pan). The pen size is adjustable.
// The paper can be blank, lined, grid or dotted.
// Saving hands back a PNG cropped to the drawing (drawn over the node's existing image, if any), plus
// the strokes so reopening carries on editing them; null when everything was erased.
export default function DrawPad({ image, drawing, onSave, onClose }: {
  image?: string,
  drawing?: SavedDrawing,
  onSave: (result: { dataUrl: string, width: number, height: number, drawing: SavedDrawing } | null) => void,
  onClose: () => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [strokes, setStrokes] = useState<Stroke[]>(() => drawing?.strokes ?? []);
  // Earlier versions of the strokes, for undo (covers both drawing and erasing)
  const [history, setHistory] = useState<Stroke[][]>([]);
  const [color, setColor] = useState(COLORS[0]);
  const [penSize, setPenSize] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(PEN_SIZE_KEY));
      if (saved >= MIN_PEN && saved <= MAX_PEN) return saved;
    } catch {}
    return 3;
  });
  const [isEraser, setIsEraser] = useState(false);
  const current = useRef<{ pointerId: number, stroke: Stroke, snapped?: boolean } | null>(null);
  // Where the pen has been resting, and the timer that snaps the stroke if it stays there
  const hold = useRef<{ x: number, y: number, timer: number } | null>(null);
  const [, setSnapCount] = useState(0);
  // An eraser drag: strokes removed so far and the strokes from before it (one undo step)
  const erasing = useRef<{ pointerId: number, before: Stroke[], left: Stroke[] } | null>(null);
  const lastPenTap = useRef<{ time: number, x: number, y: number } | null>(null);
  const penDown = useRef<{ time: number, x: number, y: number, moved: boolean } | null>(null);
  const [eraserPos, setEraserPos] = useState<Point | null>(null);
  const [fingerDraw, setFingerDraw] = useState(false);
  const background = useRef<{ img: HTMLImageElement, x: number, y: number, w: number, h: number } | null>(null);
  const [, setBackgroundReady] = useState(false);
  const [view, setView] = useState<View>({ scale: 1, x: 0, y: 0 });
  // Fingers on the canvas, and the pinch they're doing once there are two
  const touches = useRef(new Map<number, { x: number, y: number }>());
  const pinch = useRef<{ dist: number, midX: number, midY: number, view: View } | null>(null);
  // A one-finger drag that moves the page (when fingers don't draw)
  const pan = useRef<{ pointerId: number, x: number, y: number, view: View } | null>(null);
  const [paper, setPaper] = useState<Paper>(() => {
    if (drawing) return drawing.paper;
    try {
      const saved = localStorage.getItem(PAPER_KEY);
      if (PAPERS.some(p => p.id === saved)) return saved as Paper;
    } catch {}
    return 'blank';
  });
  const padRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const drawStroke = (ctx: CanvasRenderingContext2D, s: Stroke) => {
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const pts = s.points;
    if (pts.length === 1) {
      ctx.beginPath();
      ctx.arc(pts[0].x, pts[0].y, s.size * (0.5 + pts[0].pressure) / 2, 0, Math.PI * 2);
      ctx.fill();
    }
    for (let i = 1; i < pts.length; i++) {
      ctx.beginPath();
      ctx.lineWidth = s.size * (0.5 + pts[i].pressure);
      ctx.moveTo(pts[i - 1].x, pts[i - 1].y);
      ctx.lineTo(pts[i].x, pts[i].y);
      ctx.stroke();
    }
  };

  const render = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr * view.scale, 0, 0, dpr * view.scale, dpr * view.x, dpr * view.y);
    drawPaper(ctx, paper, -view.x / view.scale, -view.y / view.scale,
      (canvas.width / dpr - view.x) / view.scale, (canvas.height / dpr - view.y) / view.scale, view.scale);
    const bg = background.current;
    if (bg) ctx.drawImage(bg.img, bg.x, bg.y, bg.w, bg.h);
    for (const st of erasing.current ? erasing.current.left : strokes) drawStroke(ctx, st);
    if (current.current) drawStroke(ctx, current.current.stroke);
    if (eraserPos) {
      ctx.beginPath();
      ctx.arc(eraserPos.x, eraserPos.y, ERASER_RADIUS / view.scale, 0, Math.PI * 2);
      ctx.strokeStyle = '#fbbf24';
      ctx.lineWidth = 1.5 / view.scale;
      ctx.stroke();
    }
  }, [strokes, eraserPos, view, paper]);

  // Size the canvas to its box in device pixels, and fit the node's existing image into it
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      render();
    };
    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, [render]);

  // The image to draw over: a reopened drawing's original base, where it was before; otherwise the node's image
  const baseImage = drawing ? drawing.base : image;
  useEffect(() => {
    if (!baseImage) return;
    const img = new window.Image();
    img.onload = () => {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const scale = Math.min(1, (rect.width - 2 * PADDING) / img.width, (rect.height - 2 * PADDING) / img.height);
      background.current = { img, ...(drawing?.baseRect ?? { x: PADDING, y: PADDING, w: img.width * scale, h: img.height * scale }) };
      setBackgroundReady(true);
    };
    img.src = baseImage;
  }, [baseImage]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { render(); });

  useEffect(() => () => { if (hold.current) clearTimeout(hold.current.timer); }, []);

  useEffect(() => {
    try { localStorage.setItem(PAPER_KEY, paper); } catch {}
  }, [paper]);

  useEffect(() => {
    try { localStorage.setItem(PEN_SIZE_KEY, String(penSize)); } catch {}
  }, [penSize]);

  // Zoom to `scale`, keeping the page point under screen point (sx, sy) where it is
  const zoomAround = (v: View, scale: number, sx: number, sy: number): View => {
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale));
    return { scale: next, x: sx - (sx - v.x) * next / v.scale, y: sy - (sy - v.y) * next / v.scale };
  };

  const zoomBy = (factor: number) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    setView(v => zoomAround(v, v.scale * factor, rect.width / 2, rect.height / 2));
  };

  // Wheel pans; ctrl/⌘+wheel (which is also how a trackpad pinch arrives) zooms around the cursor.
  // Needs a non-passive listener to stop the page itself from zooming.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) {
        setView(v => zoomAround(v, v.scale * Math.exp(-e.deltaY * 0.01), e.clientX - rect.left, e.clientY - rect.top));
      } else {
        setView(v => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
      }
    };
    // Safari also turns pencil and finger touches into its own gestures (selection loupe, scrolling,
    // double-tap zoom), which can swallow the start of a stroke; claim them all for drawing
    const claim = (e: TouchEvent) => e.preventDefault();
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('touchstart', claim, { passive: false });
    canvas.addEventListener('touchmove', claim, { passive: false });
    return () => {
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('touchstart', claim);
      canvas.removeEventListener('touchmove', claim);
    };
  }, []);

  // Block text selection anywhere on the page while drawing (iPad Safari can still start one from a
  // pencil drag or long press despite user-select), and drop any selection that was already there
  useEffect(() => {
    window.getSelection()?.removeAllRanges();
    const block = (e: Event) => e.preventDefault();
    document.addEventListener('selectstart', block);
    document.addEventListener('contextmenu', block);
    return () => {
      document.removeEventListener('selectstart', block);
      document.removeEventListener('contextmenu', block);
    };
  }, []);

  useEffect(() => {
    const onChange = () => setIsFullscreen(document.fullscreenElement === padRef.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    };
  }, []);

  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else padRef.current?.requestFullscreen?.().catch(() => {});
  };

  const stopHold = () => {
    if (hold.current) clearTimeout(hold.current.timer);
    hold.current = null;
  };

  // (Re)start the hold timer whenever the pen moves away from where it was resting
  const watchHold = (p: { x: number, y: number }) => {
    // (in screen pixels, so it feels the same at any zoom)
    if (hold.current && Math.hypot(p.x - hold.current.x, p.y - hold.current.y) <= HOLD_TOLERANCE / view.scale) return;
    stopHold();
    const timer = window.setTimeout(() => {
      hold.current = null;
      const cur = current.current;
      if (!cur || cur.snapped) return;
      const shape = recognizeShape(cur.stroke);
      if (!shape) return;
      cur.stroke = { ...cur.stroke, points: shape };
      cur.snapped = true;
      setSnapCount(n => n + 1);
    }, HOLD_MS);
    hold.current = { x: p.x, y: p.y, timer };
  };

  const toPoint = (e: React.PointerEvent, v = view): Point => {
    const rect = canvasRef.current!.getBoundingClientRect();
    // Mouse and finger report 0 or 0.5; only the pencil has real pressure
    const pressure = e.pointerType === 'pen' ? e.pressure : 0.5;
    return { x: (e.clientX - rect.left - v.x) / v.scale, y: (e.clientY - rect.top - v.y) / v.scale, pressure };
  };

  const eraseAt = (p: Point) => {
    const er = erasing.current!;
    const left = er.left.filter(st => !strokeHit(st, p, ERASER_RADIUS / view.scale));
    if (left.length !== er.left.length) er.left = left;
  };

  const startPinch = () => {
    const [a, b] = [...touches.current.values()];
    pinch.current = { dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), midX: (a.x + b.x) / 2, midY: (a.y + b.y) / 2, view };
  };

  const startPan = (pointerId: number, at: { x: number, y: number }, from: View) => {
    pan.current = { pointerId, x: at.x, y: at.y, view: from };
  };

  // The pencil (or mouse) is mid-stroke, as opposed to a finger drawing
  const penBusy = () => {
    const id = current.current?.pointerId ?? erasing.current?.pointerId;
    return id !== undefined && !touches.current.has(id);
  };

  // A stroke or erase whose lift never arrived (Safari sometimes drops it): keep what it did,
  // instead of leaving it to block every stroke after it
  const finishStale = () => {
    stopHold();
    if (current.current) {
      const { stroke } = current.current;
      current.current = null;
      setHistory(h => [...h, strokes]);
      setStrokes(s => [...s, stroke]);
    }
    if (erasing.current) {
      const { before, left } = erasing.current;
      erasing.current = null;
      setEraserPos(null);
      if (left.length !== before.length) {
        setHistory(h => [...h, before]);
        setStrokes(left);
      }
    }
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType === 'touch') {
      const rect = canvasRef.current!.getBoundingClientRect();
      touches.current.set(e.pointerId, { x: e.clientX - rect.left, y: e.clientY - rect.top });
      e.currentTarget.setPointerCapture(e.pointerId);
      // While the pencil writes, any touch is the palm: no pinching or panning
      if (penBusy()) return;
      if (touches.current.size === 2) {
        // A second finger: it's a pinch, so drop whatever the first finger started drawing, erasing or panning
        pan.current = null;
        if (current.current && touches.current.has(current.current.pointerId)) { current.current = null; stopHold(); }
        if (erasing.current && touches.current.has(erasing.current.pointerId)) { erasing.current = null; setEraserPos(null); }
        startPinch();
        render();
        return;
      }
      if (touches.current.size > 2) return;
      if (!fingerDraw) {
        // Not while the pencil is drawing: that's the palm resting on the screen
        if (!current.current && !erasing.current) startPan(e.pointerId, touches.current.get(e.pointerId)!, view);
        return;
      }
    }
    let v = view;
    if (e.pointerType !== 'touch') {
      // The pencil wins over a palm that landed first: undo the pan or pinch it started, and end it
      const gesture = pan.current ?? pinch.current;
      if (gesture) {
        v = gesture.view;
        setView(v);
        pan.current = null;
        pinch.current = null;
      }
      if ((current.current || erasing.current) && (current.current ?? erasing.current)!.pointerId !== e.pointerId) finishStale();
    }
    if (current.current || erasing.current) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = toPoint(e, v);
    if (e.pointerType === 'pen') penDown.current = { time: Date.now(), x: p.x, y: p.y, moved: false };
    if (isEraser) {
      erasing.current = { pointerId: e.pointerId, before: strokes, left: strokes };
      eraseAt(p);
      setEraserPos(p);
    } else {
      current.current = { pointerId: e.pointerId, stroke: { color, size: penSize, points: [p] } };
      watchHold(p);
    }
    render();
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (e.pointerType === 'touch' && touches.current.has(e.pointerId)) {
      const rect = canvasRef.current!.getBoundingClientRect();
      touches.current.set(e.pointerId, { x: e.clientX - rect.left, y: e.clientY - rect.top });
      const pc = pinch.current;
      if (pc && touches.current.size >= 2) {
        const [a, b] = [...touches.current.values()];
        const midX = (a.x + b.x) / 2, midY = (a.y + b.y) / 2;
        const zoomed = zoomAround(pc.view, pc.view.scale * Math.hypot(a.x - b.x, a.y - b.y) / pc.dist, pc.midX, pc.midY);
        // Zoom around where the pinch started, then follow the fingers as they move
        setView({ ...zoomed, x: zoomed.x + midX - pc.midX, y: zoomed.y + midY - pc.midY });
        return;
      }
      const pn = pan.current;
      if (pn?.pointerId === e.pointerId) {
        const at = touches.current.get(e.pointerId)!;
        setView({ ...pn.view, x: pn.view.x + at.x - pn.x, y: pn.view.y + at.y - pn.y });
        return;
      }
    }
    const active = current.current?.pointerId === e.pointerId || erasing.current?.pointerId === e.pointerId;
    if (!active) return;
    // Coalesced events give the pencil's full 240Hz detail for smoother lines
    const events = e.nativeEvent.getCoalescedEvents?.() ?? [e.nativeEvent];
    const rect = canvasRef.current!.getBoundingClientRect();
    const points = events.map(ev => ({
      x: (ev.clientX - rect.left - view.x) / view.scale,
      y: (ev.clientY - rect.top - view.y) / view.scale,
      pressure: e.pointerType === 'pen' ? ev.pressure : 0.5
    }));
    const last = points[points.length - 1];
    if (penDown.current && Math.hypot(last.x - penDown.current.x, last.y - penDown.current.y) > 6) penDown.current.moved = true;
    if (erasing.current) {
      points.forEach(eraseAt);
      setEraserPos(last);
    } else if (!current.current!.snapped) {
      // Once snapped, the shape stays put until the pen lifts
      current.current!.stroke.points.push(...points);
      watchHold(last);
    }
    render();
  };

  // A short pencil tap with no movement; two in a row toggle pen / eraser
  const isDoubleTap = () => {
    const down = penDown.current;
    penDown.current = null;
    if (!down) return false;
    if (down.moved || Date.now() - down.time > TAP_MS) { lastPenTap.current = null; return false; }
    const prev = lastPenTap.current;
    // (distance in screen pixels)
    if (prev && down.time - prev.time < DOUBLE_TAP_MS && Math.hypot(down.x - prev.x, down.y - prev.y) * view.scale < DOUBLE_TAP_DIST) {
      lastPenTap.current = null;
      return true;
    }
    lastPenTap.current = { time: down.time, x: down.x, y: down.y };
    return false;
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (e.pointerType === 'touch' && touches.current.delete(e.pointerId)) {
      if (pan.current?.pointerId === e.pointerId) {
        pan.current = null;
        return;
      }
      if (pinch.current) {
        // A finger left the pinch: carry on with the remaining two, pan with the one left, or stop
        if (touches.current.size >= 2) startPinch();
        else {
          pinch.current = null;
          const [rest] = [...touches.current.entries()];
          if (rest && !fingerDraw && !penBusy()) startPan(rest[0], rest[1], view);
        }
        return;
      }
    }
    // Not this pointer's stroke (e.g. the palm lifting while the pencil writes): leave it alone
    if (current.current?.pointerId !== e.pointerId && erasing.current?.pointerId !== e.pointerId) {
      if (e.pointerType === 'pen') penDown.current = null;
      return;
    }
    stopHold();
    const doubleTap = e.pointerType === 'pen' && isDoubleTap();
    if (erasing.current?.pointerId === e.pointerId) {
      const { before, left } = erasing.current;
      erasing.current = null;
      setEraserPos(null);
      // One erase at a time: back to the pen (and this tap doesn't start a double tap)
      setIsEraser(false);
      lastPenTap.current = null;
      if (left.length !== before.length) {
        setHistory(h => [...h, before]);
        setStrokes(left);
      }
      return;
    }
    if (current.current?.pointerId !== e.pointerId) return;
    const { stroke, snapped } = current.current;
    current.current = null;
    if (doubleTap) {
      // The first tap left a dot; take it back along with switching to the eraser
      setIsEraser(true);
      setHistory(h => {
        const prev = h[h.length - 1];
        if (prev) setStrokes(prev);
        return h.slice(0, -1);
      });
      return;
    }
    setHistory(h => [...h, strokes]);
    if (!snapped && isScribble(stroke)) {
      const crossedOut = scribbledOut(stroke, strokes);
      if (crossedOut.length) {
        // The scribble and what it crossed out both go
        setStrokes(strokes.filter(st => !crossedOut.includes(st)));
        return;
      }
    }
    setStrokes(s => [...s, stroke]);
  };

  const undo = () => {
    const prev = history[history.length - 1];
    if (!prev) return;
    setStrokes(prev);
    setHistory(h => h.slice(0, -1));
  };

  const clear = () => {
    setHistory(h => [...h, strokes]);
    setStrokes([]);
  };

  const save = () => {
    const bg = background.current;
    if (!strokes.length && !bg) {
      // Reopened and erased completely: the drawing goes; otherwise there was nothing to save
      if (drawing) onSave(null);
      else onClose();
      return;
    }
    // Crop to everything drawn plus the background image
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const s of strokes) for (const p of s.points) {
      const r = s.size;
      minX = Math.min(minX, p.x - r); minY = Math.min(minY, p.y - r);
      maxX = Math.max(maxX, p.x + r); maxY = Math.max(maxY, p.y + r);
    }
    if (bg) {
      minX = Math.min(minX, bg.x); minY = Math.min(minY, bg.y);
      maxX = Math.max(maxX, bg.x + bg.w); maxY = Math.max(maxY, bg.y + bg.h);
    }
    minX -= PADDING; minY -= PADDING; maxX += PADDING; maxY += PADDING;
    const width = Math.ceil(maxX - minX);
    const height = Math.ceil(maxY - minY);

    // Export at 2x for a sharp image, on a solid background so the AI (OCR/summaries) can read it
    const scale = 2;
    const out = document.createElement('canvas');
    out.width = width * scale;
    out.height = height * scale;
    const ctx = out.getContext('2d')!;
    ctx.fillStyle = BACKGROUND;
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.scale(scale, scale);
    ctx.translate(-minX, -minY);
    drawPaper(ctx, paper, minX, minY, maxX, maxY, 1);
    if (bg) ctx.drawImage(bg.img, bg.x, bg.y, bg.w, bg.h);
    for (const st of strokes) drawStroke(ctx, st);

    const dataUrl = out.toDataURL('image/png');
    // Rounded, to keep the saved map small
    const round = (v: number, places: number) => Math.round(v * 10 ** places) / 10 ** places;
    const kept = strokes.map(st => ({ ...st, points: st.points.map(p => ({ x: round(p.x, 1), y: round(p.y, 1), pressure: round(p.pressure, 2) })) }));
    onSave({
      dataUrl, width, height,
      drawing: { strokes: kept, paper, image: dataUrl, ...(bg && baseImage ? { base: baseImage, baseRect: { x: bg.x, y: bg.y, w: bg.w, h: bg.h } } : {}) }
    });
  };

  return (
    <div className="draw-pad-backdrop">
      <div className="draw-pad" ref={padRef}>
        <div className="draw-pad-header">
          <button className={`tool-button${!isEraser ? ' active' : ''}`} title="Pen" onClick={() => setIsEraser(false)}>
            <PenLine size={18} />
          </button>
          {COLORS.map(c => (
            <button
              key={c}
              className="draw-pad-color"
              title="Pen color"
              onClick={() => { setColor(c); setIsEraser(false); }}
              style={{ background: c, outline: !isEraser && color === c ? '2px solid #fbbf24' : 'none' }}
            />
          ))}
          <label className="draw-pad-size" title={`Pen size: ${penSize}`}>
            <span className="draw-pad-size-preview">
              <span style={{ width: penSize + 2, height: penSize + 2, background: color, borderRadius: '50%' }} />
            </span>
            <input
              type="range"
              min={MIN_PEN}
              max={MAX_PEN}
              step={0.5}
              value={penSize}
              onChange={e => { setPenSize(Number(e.target.value)); setIsEraser(false); }}
            />
          </label>
          <button className={`tool-button${isEraser ? ' active' : ''}`} title="Eraser: removes whole strokes (or double-tap with the pencil)" onClick={() => setIsEraser(true)}>
            <Eraser size={18} />
          </button>
          <button className={`tool-button${fingerDraw ? ' active' : ''}`} title={fingerDraw ? 'Finger drawing on' : 'Finger drawing off (two fingers still zoom)'} onClick={() => setFingerDraw(f => !f)}>
            <Hand size={18} />
          </button>
          <button className="tool-button" title="Undo" disabled={!history.length} onClick={undo}>
            <Undo2 size={18} />
          </button>
          <button className="tool-button" title="Clear" disabled={!strokes.length} onClick={clear}>
            <Trash2 size={18} />
          </button>
          <div className="draw-pad-group">
            {PAPERS.map(({ id, title, Icon }) => (
              <button key={id} className={`tool-button${paper === id ? ' active' : ''}`} title={title} onClick={() => setPaper(id)}>
                <Icon size={18} />
              </button>
            ))}
          </div>
          <div className="draw-pad-group">
            <button className="tool-button" title="Zoom out (or pinch)" disabled={view.scale <= MIN_ZOOM} onClick={() => zoomBy(1 / 1.25)}>
              <ZoomOut size={18} />
            </button>
            <button className="tool-button draw-pad-zoom" title="Back to 100%" onClick={() => setView({ scale: 1, x: 0, y: 0 })}>
              {Math.round(view.scale * 100)}%
            </button>
            <button className="tool-button" title="Zoom in (or pinch)" disabled={view.scale >= MAX_ZOOM} onClick={() => zoomBy(1.25)}>
              <ZoomIn size={18} />
            </button>
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: '4px' }}>
            {typeof document !== 'undefined' && document.fullscreenEnabled && (
              <button className="tool-button" title={isFullscreen ? 'Exit full screen' : 'Full screen'} onClick={toggleFullscreen}>
                {isFullscreen ? <Minimize size={18} /> : <Maximize size={18} />}
              </button>
            )}
            <button className="tool-button" title="Cancel" onClick={onClose} style={{ color: 'white' }}>
              <X size={18} />
            </button>
            <button className="tool-button" title="Save the drawing into the node" onClick={save} style={{ color: '#10b981' }}>
              <Check size={18} />
              <span className="tool-label">Done</span>
            </button>
          </div>
        </div>
        <canvas
          ref={canvasRef}
          className="draw-pad-canvas"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onLostPointerCapture={onPointerUp}
        />
      </div>
    </div>
  );
}
