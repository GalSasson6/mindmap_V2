import { NextResponse } from 'next/server';
import { DEFAULT_MODEL, WORKING_MODELS } from '@/lib/gemini';

// The models the settings' model picker offers: only the ones known to work with our keys
export async function GET() {
  return NextResponse.json({ models: WORKING_MODELS, defaultModel: DEFAULT_MODEL });
}
