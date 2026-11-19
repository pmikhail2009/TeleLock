import { readFile } from 'node:fs/promises';

const panel = new URL('../mod/panel/index.html', import.meta.url);

export async function servePanel(res) {
  try {
    const html = await readFile(panel);
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    res.end(html);
  } catch {
    res.writeHead(503);
    res.end('KATKA panel unavailable');
  }
}
