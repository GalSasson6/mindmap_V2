import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import { courseExists, coursePath, isValidCourseName, listCourses, writeCourse } from '@/lib/courses';

export async function GET() {
  try {
    return NextResponse.json({ courses: await listCourses() });
  } catch (err) {
    console.error('Failed to list courses', err);
    return NextResponse.json({ error: 'Failed to list courses' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const { action, courseName, newCourseName } = await req.json().catch(() => ({}));

  if (!isValidCourseName(courseName)) {
    return NextResponse.json({ error: 'Invalid course name' }, { status: 400 });
  }

  try {
    switch (action) {
      case 'create': {
        if (await courseExists(courseName)) {
          return NextResponse.json({ error: 'Course already exists' }, { status: 409 });
        }
        await writeCourse(courseName, { nodes: [], edges: [] });
        return NextResponse.json({ ok: true });
      }

      case 'rename': {
        if (!isValidCourseName(newCourseName)) {
          return NextResponse.json({ error: 'Invalid new course name' }, { status: 400 });
        }
        if (!(await courseExists(courseName))) {
          return NextResponse.json({ error: 'Course not found' }, { status: 404 });
        }
        if (await courseExists(newCourseName)) {
          return NextResponse.json({ error: 'A course with that name already exists' }, { status: 409 });
        }
        await fs.rename(coursePath(courseName), coursePath(newCourseName));
        return NextResponse.json({ ok: true });
      }

      case 'delete': {
        await fs.rm(coursePath(courseName), { force: true });
        return NextResponse.json({ ok: true });
      }

      default:
        return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
    }
  } catch (err) {
    console.error(`Course ${action} failed`, err);
    return NextResponse.json({ error: `Failed to ${action} course` }, { status: 500 });
  }
}
