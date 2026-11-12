// The Gemini models the app may use, shared by the server and the settings' model picker

// The ones that answered a summary request reliably with our keys
// (tested 2026-10-20; others timed out, hit quota errors or were unavailable). Fastest first.
export const WORKING_MODELS = [
  { id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash-Lite', seconds: 1.2 },
  { id: 'gemini-flash-lite-latest', name: 'Gemini Flash-Lite Latest', seconds: 1.2 },
  { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', seconds: 3.0 },
  { id: 'gemini-3.5-flash-lite', name: 'Gemini 3.5 Flash-Lite', seconds: 3.2 },
  { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', seconds: 5.3 },
  { id: 'gemini-3-flash-preview', name: 'Gemini 3 Flash Preview', seconds: 6.1 },
  { id: 'gemini-3.6-flash', name: 'Gemini 3.6 Flash', seconds: 8.1 },
];

export const isWorkingModel = (id: unknown): id is string =>
  typeof id === 'string' && WORKING_MODELS.some(m => m.id === id);
