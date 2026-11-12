import { NextRequest, NextResponse } from 'next/server';
import { ApiError, GoogleGenAI, type Part } from '@google/genai';
import { apiKeys, DEFAULT_MODEL, isWorkingModel, WORKING_MODELS } from '@/lib/gemini';

const OCR_PROMPT = `You are an OCR engine. Transcribe ALL text in the image exactly as written, in its original language.
Do NOT summarize, translate, rephrase, explain, correct, reorder, or add anything.
Keep the original line breaks, lists, numbering, and structure.
Write math as LaTeX wrapped in dollar signs ($...$ inline, $$...$$ for display) so it renders; reproduce it exactly, without adding colors.
Write tables as Markdown tables.
Return ONLY the transcription.`;

// Rotate the starting key across requests so quota is spread over all keys.
let nextKeyIndex = 0;

// How long a model may take before the next (lower) model is tried; an overloaded model can hang
// for minutes, so a slow one shouldn't hold the request.
// The whole request stops after REQUEST_TIMEOUT_MS so the client gets an answer either way.
// Simplify levels, from plain intuition to precise terminology
const SIMPLE_LEVELS = [
  'Talk like a friend explaining it over coffee: plain everyday words, short sentences, and an everyday analogy if it helps. ' +
    'Focus on what it is and why it matters. Still name the one key real term of the topic once, saying what it means in plain words.',
  'Keep it friendly and intuitive, but use the correct technical terms for the key ideas, each followed by a short plain-words explanation. ' +
    'Prefer a concrete picture over a loose analogy.',
  'Be accurate: use the field\'s proper terminology and notation, in a clear, relaxed tone. ' +
    'Mention the key condition or caveat if it matters, and drop any analogy that is not exact.',
  'Be precise, at textbook level: the formal definition or statement with correct terminology and notation, then one line of intuition. Still concise.'
];
const SIMPLE_WORDS = [80, 90, 100, 120];

const KEY_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 60_000;

// The models a failed request falls back to, highest first; Gemini 3 is the lowest it goes
const FALLBACK_LADDER = ['gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-3-flash-preview'];

// The model to try first, then the ladder models below it, closest first; a model not on the
// ladder (the 2.5 ones) falls back to the whole ladder, fastest first
function modelChain(first: string): string[] {
  const index = FALLBACK_LADDER.indexOf(first);
  if (index >= 0) return FALLBACK_LADDER.slice(index);
  const speed = (id: string) => WORKING_MODELS.find(m => m.id === id)?.seconds ?? Infinity;
  return [first, ...[...FALLBACK_LADDER].sort((a, b) => speed(a) - speed(b))];
}

// Overload, server errors and timeouts hit the model for every key, so the next model is tried;
// anything else (bad key, quota) is specific to the key, so the next key is tried
const isModelFailure = (err: unknown) =>
  (err instanceof ApiError && (err.status >= 500 || err.status === 404)) ||
  (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError'));

// Google's errors come as a JSON string; keep just its message
function errorMessage(err: unknown): string {
  if (!(err instanceof Error)) return 'Unknown error';
  try { return JSON.parse(err.message).error?.message || err.message; } catch { return err.message; }
}

function parseDataUrl(dataUrl: string): Part | null {
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!match) return null;
  return { inlineData: { mimeType: match[1], data: match[2] } };
}

export async function POST(req: NextRequest) {
  if (apiKeys.length === 0) {
    return NextResponse.json({ error: 'No Gemini API key configured (set GEMINI_API_KEYS in .env.local)' }, { status: 500 });
  }

  const { content, mode, image, maxWords, systemPrompt, level, previous, direction, model: requestedModel } = await req.json().catch(() => ({}));
  // The model picked in the settings; anything outside the working models falls back to the default
  const model = isWorkingModel(requestedModel) ? requestedModel : DEFAULT_MODEL;
  const imagePart = typeof image === 'string' ? parseDataUrl(image) : null;
  const isOcr = mode === 'ocr';

  if (isOcr ? !imagePart : typeof content !== 'string' || !content.trim()) {
    return NextResponse.json({ error: isOcr ? 'OCR needs an image' : 'Missing content' }, { status: 400 });
  }

  const titleRule =
    '\nThe FIRST line of your response must be "TITLE: <a short title for the node, 2-6 words, in the same language as the content, plain text without LaTeX>", followed by the content on the next lines.';

  let promptText: string;
  let systemInstruction: string | undefined;
  if (isOcr) {
    // Pure transcription: ignore the user's summarizing system prompt and word limits.
    systemInstruction = OCR_PROMPT;
    promptText = `Transcribe the attached image.${titleRule}`;
  } else if (mode === 'example') {
    // A new node with a tiny example of this node's term; the node itself stays as it is
    const limit = Number(maxWords) > 0 ? Number(maxWords) : 40;
    const imageNote = imagePart ? '\n\nThe attached image is part of this node\'s content.' : '';
    promptText = `${content}${imageNote}\n\nGive ONE tiny example of the main term or concept of this node that makes it click at a glance. ` +
      'Show, don\'t explain: the simplest possible case with small numbers, as a short line or formula plus at most one short sentence. ' +
      'No introduction, no step-by-step walkthrough, no definition, no restating the concept. ' +
      'Write math as LaTeX in dollar signs ($...$), never in backticks. ' +
      `Write in the same language as the node. At most ${limit} words.` +
      titleRule.replace('a short title for the node', 'a short title for the example node');
    systemInstruction = typeof systemPrompt === 'string' && systemPrompt.trim() ? systemPrompt : undefined;
  } else if (mode === 'simple') {
    // A new node explaining this node's topic informally; the node itself stays as it is.
    // `level` moves it between plain intuition (1) and precise, textbook terms (4); `previous` is the
    // current explanation when an existing simple node is rewritten one level up or down
    const lvl = Math.min(SIMPLE_LEVELS.length, Math.max(1, Math.round(Number(level)) || 1));
    const limit = Number(maxWords) > 0 ? Number(maxWords) : SIMPLE_WORDS[lvl - 1];
    const imageNote = imagePart ? '\n\nThe attached image is part of this node\'s content.' : '';
    const previousNote = typeof previous === 'string' && previous.trim()
      ? `\n\nCurrent explanation (rewrite it at the level below, keeping what already works):\n${previous}`
      : '';
    promptText = `${content}${imageNote}${previousNote}\n\nExplain the main topic of this node so a learner gets the core idea. ` +
      `${SIMPLE_LEVELS[lvl - 1]} ` +
      'Never say anything technically wrong for the sake of simplicity: simplify by leaving details out, not by bending the truth. ' +
      'Use math only if it is needed, as LaTeX in dollar signs ($...$), never in backticks. ' +
      `Write in the same language as the node. At most ${limit} words.` +
      titleRule.replace('a short title for the node', 'a short title for the explanation node');
    systemInstruction = typeof systemPrompt === 'string' && systemPrompt.trim() ? systemPrompt : undefined;
  } else if (mode === 'refine') {
    // Rewrites a node that has no Simplify level (an older or other generated node) one step
    // more precise or simpler than it is now; the client replaces the node's content with it
    const precise = direction !== 'simpler';
    const currentWords = content.split(/\s+/).length;
    const limit = Number(maxWords) > 0 ? Number(maxWords) : Math.max(60, Math.round(currentWords * (precise ? 1.5 : 0.9)));
    const imageNote = imagePart ? '\n\nThe attached image is part of this node\'s content.' : '';
    const directionRule = precise
      ? 'Rewrite this node\'s content one step MORE PRECISE: use the field\'s proper terminology and notation, state the key definition, condition or caveat it glosses over, and replace anything vague or loose with the exact statement.'
      : 'Rewrite this node\'s content one step SIMPLER: plain everyday words, short sentences, and a concrete picture if it helps; leave details out but keep the one key real term, explained in plain words.';
    promptText = `${content}${imageNote}\n\n${directionRule} ` +
      'Keep the same topic and the same kind of text (an example stays an example, an explanation stays an explanation), and keep what already works. ' +
      'Never say anything technically wrong. ' +
      'Write math as LaTeX in dollar signs ($...$), never in backticks. ' +
      `Write in the same language as the node. At most ${limit} words.` +
      titleRule;
    systemInstruction = typeof systemPrompt === 'string' && systemPrompt.trim() ? systemPrompt : undefined;
  } else {
    const limit = Number(maxWords) > 0 ? Number(maxWords) : mode === 'short' ? 15 : 50;
    const lengthRule =
      mode === 'short'
        ? `Give a very short summary: at most ${limit} words.`
        : `Keep the response to at most ${limit} words.`;
    // The client replaces the image with this response, so it must carry the image's content itself.
    const imageRule = imagePart
      ? '\n\nThe attached image is this node\'s main content and your response will REPLACE the image in the node. Convert everything important in it (text, formulas, tables, diagrams) into text, so the image is no longer needed.' +
        titleRule
      : '';
    promptText = `${content}${imageRule}\n\n${lengthRule}`;
    systemInstruction = typeof systemPrompt === 'string' && systemPrompt.trim() ? systemPrompt : undefined;
  }

  const parts: Part[] = [{ text: promptText }];
  if (imagePart) parts.push(imagePart);

  let lastError: unknown;
  const deadline = Date.now() + REQUEST_TIMEOUT_MS;
  const triedModels: string[] = [];
  for (const currentModel of modelChain(model)) {
    if (deadline - Date.now() <= 0) break;
    triedModels.push(currentModel);
    const start = nextKeyIndex++ % apiKeys.length;
    for (let i = 0; i < apiKeys.length; i++) {
      const keyNumber = (start + i) % apiKeys.length;
      const timeLeft = deadline - Date.now();
      if (timeLeft <= 0) break;
      try {
        const ai = new GoogleGenAI({ apiKey: apiKeys[keyNumber] });
        const response = await ai.models.generateContent({
          model: currentModel,
          contents: [{ role: 'user', parts }],
          config: {
            ...(systemInstruction ? { systemInstruction } : {}),
            abortSignal: AbortSignal.timeout(Math.min(KEY_TIMEOUT_MS, timeLeft)),
          },
        });
        let text = response.text?.trim();
        if (!text) throw new Error('Empty response from model');

        let title: string | undefined;
        const titleMatch = /^\**\s*TITLE\s*:\s*\**\s*(.+?)\s*\**\s*(?:\n|$)/i.exec(text);
        if (titleMatch) {
          title = titleMatch[1].replace(/[*#`$]/g, '').trim() || undefined;
          text = text.slice(titleMatch[0].length).trim();
        }
        if (currentModel !== model) console.warn(`${model} failed, answered by ${currentModel}`);
        return NextResponse.json({ content: text, title, model: currentModel });
      } catch (err) {
        lastError = err;
        console.error(`Gemini request failed with ${currentModel}, key #${keyNumber + 1}:`, errorMessage(err));
        if (isModelFailure(err)) break;
      }
    }
  }

  const message = deadline - Date.now() <= 0 && !(lastError instanceof ApiError)
    ? `no answer within ${REQUEST_TIMEOUT_MS / 1000}s`
    : errorMessage(lastError);
  return NextResponse.json({ error: `Gemini failed (tried ${triedModels.join(', ')}): ${message}` }, { status: 502 });
}
