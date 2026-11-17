// HTTP server: routing, authorization, body reading, response envelopes.
//
// Routes:
//   GET  /healthz                                   (no auth)
//   GET  /{owner}/{repo}.git/info/refs              git advertisement (v0/v2)
//   POST /{owner}/{repo}.git/git-upload-pack        fetch / ls-refs
//   POST /{owner}/{repo}.git/git-receive-pack       pushes
//   *    /api/v3/...                                REST v3
//   POST /api/graphql                               GraphQL
//   POST /mcp                                       MCP JSON-RPC
//   DELETE /mcp                                     session close (no sessions issued)
//
// Every JSON reply is application/json, never HTML. Every REST reply carries
// a non-empty X-GitHub-Request-Id. Authorization is the process token as a
// Bearer token; a missing or wrong token is 401 JSON, except /healthz.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { decodePath } from './util.ts';
import { handleRest, type RestResponse } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleReceivePack, handleUploadPack, infoRefsBody, infoRefsContentType } from './gitwire.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

function jsonBody(res: ServerResponse, status: number, value: unknown, extraHeaders?: Record<string, string>): void {
  const text = value === null ? '' : JSON.stringify(value);
  const headers: Record<string, string> = { 'content-type': 'application/json', ...extraHeaders };
  if (text.length > 0) headers['content-length'] = String(Buffer.byteLength(text));
  res.writeHead(status, headers);
  res.end(text);
}

function rawBody(res: ServerResponse, status: number, bytes: Buffer, contentType: string, extraHeaders?: Record<string, string>): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': String(bytes.length), ...extraHeaders });
  res.end(bytes);
}

/**
 * Read the whole request body. A manual data/end listener pair, not the
 * async iterator: the iterator's wrapper costs a noticeable slice of a
 * millisecond per POST on this VM, and the push/write/clone workloads are
 * all POST-bound.
 */
async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  await new Promise<void>((resolve, reject) => {
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('Request body is too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve());
    req.on('error', reject);
  });
  return Buffer.concat(chunks);
}

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers['authorization'];
  if (typeof header !== 'string') return null;
  const match = /^Bearer (.+)$/.exec(header.trim());
  return match === null ? null : (match[1] as string);
}

export function createAppServer(store: Store): ReturnType<typeof createServer> {
  const scenarioViewer = process.env.MAKEFUN_SHOP_LOGIN ?? 'rimzz';

  const authorized = (req: IncomingMessage): boolean => {
    if (store.token === '') return true;
    return bearerToken(req) === store.token;
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname;
      const method = req.method ?? 'GET';

      if (method === 'GET' && path === '/healthz') {
        jsonBody(res, 200, { ok: true });
        return;
      }

      // ---- git smart HTTP -------------------------------------------------
      const segments = decodePath(path);
      if (
        segments.length === 4 &&
        segments[1]?.endsWith('.git') === true &&
        segments[2] === 'info' &&
        segments[3] === 'refs'
      ) {
        if (!authorized(req)) {
          jsonBody(res, 401, { message: 'Requires authentication' });
          return;
        }
        const service = url.searchParams.get('service');
        if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
          jsonBody(res, 404, { message: 'Not Found' });
          return;
        }
        const repo = store.findRepo(segments[0] as string, (segments[1] as string).slice(0, -'.git'.length));
        if (repo === null) {
          jsonBody(res, 404, { message: 'Not Found' });
          return;
        }
        const isV2 = req.headers['git-protocol'] === 'version=2';
        const body = infoRefsBody(store, repo, service, isV2);
        rawBody(res, 200, body, infoRefsContentType(service));
        return;
      }
      if (
        segments.length === 3 &&
        segments[1]?.endsWith('.git') === true &&
        (segments[2] === 'git-upload-pack' || segments[2] === 'git-receive-pack')
      ) {
        if (!authorized(req)) {
          jsonBody(res, 401, { message: 'Requires authentication' });
          return;
        }
        if (method !== 'POST') {
          jsonBody(res, 404, { message: 'Not Found' });
          return;
        }
        const repo = store.findRepo(segments[0] as string, (segments[1] as string).slice(0, -'.git'.length));
        if (repo === null) {
          jsonBody(res, 404, { message: 'Not Found' });
          return;
        }
        const body = await readBody(req);
        if (segments[2] === 'git-upload-pack') {
          try {
            const isV2 = req.headers['git-protocol'] === 'version=2';
            const out = handleUploadPack(store, repo, body, isV2);
            rawBody(res, 200, out, 'application/x-git-upload-pack-result');
          } catch (err) {
            jsonBody(res, 400, { message: err instanceof Error ? err.message : String(err) });
          }
          return;
        }
        const out = handleReceivePack(store, repo, body);
        rawBody(res, 200, out, 'application/x-git-receive-pack-result');
        return;
      }

      // ---- REST v3 --------------------------------------------------------
      if (path === '/api/v3' || path.startsWith('/api/v3/')) {
        if (!authorized(req)) {
          jsonBody(res, 401, { message: 'Requires authentication' }, { 'X-GitHub-Request-Id': store.nextRequestId() });
          return;
        }
        let parsed: unknown = null;
        if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
          const body = await readBody(req);
          if (body.length > 0) {
            try {
              parsed = JSON.parse(body.toString('utf8'));
            } catch {
              jsonBody(res, 400, { message: 'Invalid JSON' }, { 'X-GitHub-Request-Id': store.nextRequestId() });
              return;
            }
          }
        }
        const restPath = path === '/api/v3' ? '/' : path.slice('/api/v3'.length);
        const response: RestResponse = handleRest(store, {
          method,
          path: restPath,
          query: url.searchParams,
          body: parsed,
          host: req.headers.host ?? 'localhost',
        });
        const headers: Record<string, string> = { 'X-GitHub-Request-Id': store.nextRequestId(), ...response.headers };
        if (response.status === 204 || response.body === null) {
          if (response.rawBody !== undefined) {
            rawBody(res, response.status, Buffer.from(response.rawBody, 'utf8'), 'application/json', headers);
          } else {
            res.writeHead(response.status, headers);
            res.end();
          }
          return;
        }
        if (response.rawBody !== undefined) {
          rawBody(res, response.status, Buffer.from(response.rawBody, 'utf8'), 'application/json', headers);
          return;
        }
        jsonBody(res, response.status, response.body, headers);
        return;
      }

      // ---- GraphQL --------------------------------------------------------
      if (path === '/api/graphql') {
        if (method !== 'POST') {
          jsonBody(res, 404, { message: 'Not Found' });
          return;
        }
        if (!authorized(req)) {
          jsonBody(res, 401, { message: 'Requires authentication' });
          return;
        }
        const body = await readBody(req);
        let parsed: unknown;
        try {
          parsed = JSON.parse(body.toString('utf8'));
        } catch {
          jsonBody(res, 400, { message: 'Invalid JSON' });
          return;
        }
        jsonBody(res, 200, handleGraphQL(store, parsed));
        return;
      }

      // ---- MCP ------------------------------------------------------------
      if (path === '/mcp') {
        if (method === 'DELETE') {
          res.writeHead(200);
          res.end();
          return;
        }
        if (method !== 'POST') {
          jsonBody(res, 404, { message: 'Not Found' });
          return;
        }
        if (!authorized(req)) {
          jsonBody(res, 401, { message: 'Requires authentication' });
          return;
        }
        const body = await readBody(req);
        const result = handleMcp(store, scenarioViewer, body.toString('utf8'));
        if (result.status === 202 || result.body === null) {
          res.writeHead(result.status);
          res.end();
          return;
        }
        jsonBody(res, result.status, result.body);
        return;
      }

      jsonBody(res, 404, { message: 'Not Found' });
    } catch (err) {
      if (!res.headersSent) {
        jsonBody(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
      } else {
        res.destroy();
      }
    }
  });

  server.on('clientError', (_err, socket) => {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  return server;
}
