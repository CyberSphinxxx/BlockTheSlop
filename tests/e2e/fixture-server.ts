import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Minimal static server for deterministic YouTube-like fixture pages.
 * Serves tests/e2e/fixtures/www.youtube.com/*.html and maps real YouTube
 * paths (/, /results, /watch ...) onto those files so the content script's
 * route detection sees authentic URLs.
 */
export class FixtureServer {
  private server: Server | null = null;
  readonly port: number;
  private readonly root: string;

  constructor(port = 0) {
    this.port = port;
    this.root = join(here, 'fixtures', 'www.youtube.com');
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
    await new Promise<void>((resolve) => {
      this.server?.listen(this.port, '127.0.0.1', resolve);
    });
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${(this.server?.address() as { port: number }).port}`;
  }

  stop(): void {
    this.server?.close();
    this.server = null;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', this.baseUrl);
      const file = this.mapPath(url.pathname);
      const html = await readFile(file, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    }
  }

  /**
   * Map YouTube-style paths to fixture HTML files.
   * URL parsing guarantees `pathname` is normalized and uses `/` separators,
   * so no platform-specific path handling is needed here.
   */
  private mapPath(pathname: string): string {
    switch (pathname) {
      case '/':
      case '/index.html':
        return join(this.root, 'home.html');
      case '/results':
        return join(this.root, 'results.html');
      case '/watch':
        return join(this.root, 'watch.html');
      case '/feed/subscriptions':
        return join(this.root, 'subscriptions.html');
      case '/feed/history':
        return join(this.root, 'history.html');
      case '/playlist':
        return join(this.root, 'playlist.html');
      case '/shorts':
      case '/shorts/fixtureid01':
        return join(this.root, 'shorts.html');
      default: {
        const name = pathname.replace(/^\//, '').split('/').join('_');
        return join(this.root, `${name === '' ? 'home' : name}.html`);
      }
    }
  }
}
