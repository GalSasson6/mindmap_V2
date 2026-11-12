// Gemini settings shared by the API routes

import { isWorkingModel } from './models';

export { WORKING_MODELS, isWorkingModel } from './models';

export const DEFAULT_MODEL = isWorkingModel(process.env.GEMINI_MODEL) ? process.env.GEMINI_MODEL : 'gemini-3.6-flash';

export const apiKeys = (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '')
  .split(',')
  // Stray quotes (e.g. a mistyped .env line) would make Google reject the key
  .map((k) => k.trim().replace(/^["']+|["']+$/g, ''))
  .filter(Boolean);
