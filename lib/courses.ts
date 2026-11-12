import { promises as fs } from 'fs';
import path from 'path';

export const DATA_DIR = path.join(process.cwd(), 'data');

// Course names map 1:1 to files in data/, so reject anything that could escape it.
export function isValidCourseName(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    name.trim().length > 0 &&
    name.length <= 200 &&
    !/[\/\\\0]/.test(name) &&
    name !== '.' &&
    name !== '..'
  );
}

export function coursePath(name: string) {
  return path.join(DATA_DIR, `${name}.json`);
}

export async function listCourses(): Promise<string[]> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const files = await fs.readdir(DATA_DIR);
  return files
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -'.json'.length))
    .sort((a, b) => a.localeCompare(b));
}

export async function courseExists(name: string) {
  try {
    await fs.access(coursePath(name));
    return true;
  } catch {
    return false;
  }
}

// Write to a temp file and rename, so a crash mid-save never leaves a truncated course file.
export async function writeCourse(name: string, data: unknown) {
  const target = coursePath(name);
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fs.rename(tmp, target);
}
