import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import { coursePath, isValidCourseName, writeCourse } from '@/lib/courses';

export async function GET(req: NextRequest) {
  const course = req.nextUrl.searchParams.get('course');
  if (!isValidCourseName(course)) {
    return NextResponse.json({ error: 'Invalid course name' }, { status: 400 });
  }

  try {
    const raw = await fs.readFile(coursePath(course), 'utf8');
    const data = JSON.parse(raw);
    return NextResponse.json({ nodes: data.nodes ?? [], edges: data.edges ?? [] });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return NextResponse.json({ nodes: [], edges: [] });
    }
    console.error('Failed to read mindmap', err);
    return NextResponse.json({ error: 'Failed to read mindmap' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const course = req.nextUrl.searchParams.get('course');
  if (!isValidCourseName(course)) {
    return NextResponse.json({ error: 'Invalid course name' }, { status: 400 });
  }

  const body = await req.json().catch(() => null);
  if (!body || !Array.isArray(body.nodes) || !Array.isArray(body.edges)) {
    return NextResponse.json({ error: 'Expected { nodes: [], edges: [] }' }, { status: 400 });
  }

  try {
    await writeCourse(course, { nodes: body.nodes, edges: body.edges });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('Failed to save mindmap', err);
    return NextResponse.json({ error: 'Failed to save mindmap' }, { status: 500 });
  }
}
