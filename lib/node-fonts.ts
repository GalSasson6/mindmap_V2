// Handwriting fonts a node's text can use (loaded in app/layout.tsx as CSS variables).
// Each pairs a Hebrew handwriting font, which only covers Hebrew letters, with an English one for
// everything else, so mixed-language text stays handwritten throughout.
export const NODE_FONTS = [
  { id: 'playpen', label: 'Playpen', family: 'var(--font-playpen-hebrew), var(--font-kalam), sans-serif' },
  { id: 'amatic', label: 'Amatic', family: 'var(--font-amatic), var(--font-shadows), sans-serif' },
  { id: 'solitreo', label: 'Solitreo', family: 'var(--font-solitreo), var(--font-caveat), sans-serif' }
] as const;

// A node without `font` uses Playpen; 'standard' is the app's regular font
const DEFAULT_FONT = 'playpen';
const CYCLE = [...NODE_FONTS.map(f => f.id), 'standard'];

export const nodeFont = (id: unknown) => NODE_FONTS.find(f => f.id === (id ?? DEFAULT_FONT));

// The font after `id` in the toolbar's cycle (undefined = back to the default)
export const nextNodeFont = (id: unknown) => {
  const next = CYCLE[(CYCLE.indexOf(typeof id === 'string' ? id : DEFAULT_FONT) + 1) % CYCLE.length];
  return next === DEFAULT_FONT ? undefined : next;
};
