import { NextRequest } from 'next/server';
import { spawn } from 'child_process';

// Snippets are rendered black-on-transparent; the client inverts them for the dark theme.
const PREAMBLE = '#set page(width: auto, height: auto, margin: 4pt, fill: none)\n';

function errorSvg(message: string, status: number) {
  const escaped = message.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]!);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="420" height="24"><text x="4" y="16" font-family="monospace" font-size="12" fill="#b91c1c">${escaped}</text></svg>`;
  return new Response(svg, { status, headers: { 'Content-Type': 'image/svg+xml' } });
}

function compileTypst(source: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const proc = spawn('typst', ['compile', '--format', 'svg', '-', '-']);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => proc.kill('SIGKILL'), 10_000);
    proc.stdout.on('data', (d) => out.push(d));
    proc.stderr.on('data', (d) => err.push(d));
    proc.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(Buffer.concat(err).toString().split('\n')[0] || `typst exited with ${code}`));
    });
    proc.stdin.end(PREAMBLE + source);
  });
}

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code');
  if (!code) return errorSvg('Missing typst code', 400);

  try {
    const svg = await compileTypst(code);
    return new Response(new Uint8Array(svg), {
      headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' },
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return errorSvg('Typst CLI not installed on the server', 501);
    }
    return errorSvg(`Typst error: ${(err as Error).message}`, 422);
  }
}
