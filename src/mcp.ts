// MCP over /mcp: JSON-RPC 2.0 over Streamable HTTP (plain JSON answers, no
// SSE). Tools act on the same store as REST, GraphQL and git, so an issue
// created here is visible everywhere else immediately.
//
// The modern discovery method is `server/discover`; `initialize` and the
// `notifications/initialized` notification are kept as a legacy fallback.
// `tools/list` returns one constant array, so two calls are byte-identical.

import { type Repo, type Store } from './store.ts';

export interface McpResponse {
  status: number;
  body: unknown;
}

const SERVER_NAME = 'forge4';
const SERVER_VERSION = '1.0.0';
const PROTOCOL_VERSIONS = ['2026-07-28', '2025-06-18'];

/** The tool list, built once: tools/list must be byte-identical across calls. */
const TOOLS: ReadonlyArray<Record<string, unknown>> = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Issue state filter: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
        body: { type: 'string', description: 'The pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
]);

interface ToolOutcome {
  ok: boolean;
  data: Record<string, unknown>;
}

function textResult(data: Record<string, unknown>): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
}

function errorResult(message: string): Record<string, unknown> {
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: message }) }] };
}

function stringArg(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  return typeof value === 'string' ? value : undefined;
}

function numberArg(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  return undefined;
}

/** Owner and repo from arguments, accepting a `full_name` of `owner/repo`. */
function ownerRepo(args: Record<string, unknown>): { owner: string; repo: string } | null {
  const owner = stringArg(args, 'owner');
  const repo = stringArg(args, 'repo');
  if (owner !== undefined && repo !== undefined) return { owner, repo };
  const fullName = stringArg(args, 'full_name');
  if (fullName !== undefined) {
    const slash = fullName.indexOf('/');
    if (slash > 0) return { owner: fullName.slice(0, slash), repo: fullName.slice(slash + 1) };
  }
  return null;
}

function findRepoOrError(
  store: Store,
  args: Record<string, unknown>,
): { ok: true; repo: Repo; owner: string } | { ok: false; error: string } {
  const target = ownerRepo(args);
  if (target === null) return { ok: false, error: 'Missing required argument: owner/repo' };
  const repo = store.findRepo(target.owner, target.repo);
  if (repo === null) return { ok: false, error: `Repository not found: ${target.owner}/${target.repo}` };
  return { ok: true, repo, owner: target.owner };
}

function callTool(store: Store, scenarioViewer: string, name: string, args: Record<string, unknown>): Record<string, unknown> {
  let outcome: ToolOutcome;
  switch (name) {
    case 'create_repo': {
      const repoName = stringArg(args, 'name');
      if (repoName === undefined || repoName.trim() === '') return errorResult('Missing required argument: name');
      if (store.repos.has(repoName)) return errorResult('Repository already exists');
      const description = stringArg(args, 'description') ?? '';
      const isPrivate = args['private'] === true;
      const repo = store.createRepo(repoName, description, isPrivate);
      const owner = store.viewer() === '' ? scenarioViewer : store.viewer();
      outcome = {
        ok: true,
        data: {
          name: repo.name,
          full_name: `${owner}/${repo.name}`,
          private: repo.isPrivate,
          description: repo.description,
          default_branch: repo.defaultBranch,
          owner: { login: owner },
        },
      };
      break;
    }
    case 'get_repo': {
      const found = findRepoOrError(store, args);
      if (!found.ok) return errorResult(found.error);
      const owner = found.owner;
      outcome = {
        ok: true,
        data: {
          name: found.repo.name,
          full_name: `${owner}/${found.repo.name}`,
          private: found.repo.isPrivate,
          description: found.repo.description,
          default_branch: found.repo.defaultBranch,
          owner: { login: owner },
        },
      };
      break;
    }
    case 'create_issue': {
      const found = findRepoOrError(store, args);
      if (!found.ok) return errorResult(found.error);
      const title = stringArg(args, 'title');
      if (title === undefined || title.trim() === '') return errorResult('Missing required argument: title');
      const issue = store.createIssue(found.repo, { title, body: stringArg(args, 'body') ?? null, labels: [] });
      outcome = {
        ok: true,
        data: { number: issue.number, title: issue.title, body: issue.body, state: issue.state, id: issue.id },
      };
      break;
    }
    case 'list_issues': {
      const found = findRepoOrError(store, args);
      if (!found.ok) return errorResult(found.error);
      const state = stringArg(args, 'state') ?? 'open';
      let issues = [...found.repo.issues];
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      else if (state !== 'all') issues = issues.filter((issue) => issue.state === 'open');
      outcome = {
        ok: true,
        data: { issues: issues.map((issue) => ({ number: issue.number, title: issue.title, state: issue.state, id: issue.id })) },
      };
      break;
    }
    case 'create_pull_request': {
      const found = findRepoOrError(store, args);
      if (!found.ok) return errorResult(found.error);
      const title = stringArg(args, 'title');
      const head = stringArg(args, 'head');
      const base = stringArg(args, 'base');
      if (title === undefined) return errorResult('Missing required argument: title');
      if (head === undefined) return errorResult('Missing required argument: head');
      if (base === undefined) return errorResult('Missing required argument: base');
      const headSha = store.branchTip(found.repo, head);
      const baseSha = store.branchTip(found.repo, base);
      if (headSha === null || baseSha === null) return errorResult('head or base branch does not exist');
      for (const existing of found.repo.pulls) {
        if (existing.state === 'open' && existing.headRef === head && existing.baseRef === base) {
          return errorResult('A pull request already exists for this head and base');
        }
      }
      const pull = store.createPull(found.repo, {
        title,
        body: stringArg(args, 'body') ?? null,
        headRef: head,
        baseRef: base,
        headSha,
        baseSha,
      });
      outcome = {
        ok: true,
        data: {
          number: pull.number,
          title: pull.title,
          body: pull.body,
          state: pull.state,
          head: { ref: pull.headRef, sha: pull.headSha },
          base: { ref: pull.baseRef, sha: pull.baseSha },
        },
      };
      break;
    }
    case 'merge_pull_request': {
      const found = findRepoOrError(store, args);
      if (!found.ok) return errorResult(found.error);
      const pullNumber = numberArg(args, 'pull_number');
      if (pullNumber === undefined) return errorResult('Missing required argument: pull_number');
      const pull = found.repo.pullByNumber.get(pullNumber);
      if (pull === undefined) return errorResult(`Pull request not found: ${pullNumber}`);
      const result = store.squashMergePull(found.repo, pull);
      if (!result.ok) return errorResult('Merge conflict');
      outcome = { ok: true, data: { number: pull.number, merged: true, sha: result.sha, state: pull.state } };
      break;
    }
    default:
      return errorResult(`Unknown tool: ${name}`);
  }
  return outcome.ok ? textResult(outcome.data) : errorResult(String(outcome.data['error'] ?? 'Tool failed'));
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

/**
 * Handle one POST /mcp body. `bodyText` is the raw request text; a body
 * that is not JSON answers HTTP 400 with JSON-RPC -32700. The caller checks
 * authorization before this runs.
 */
export function handleMcp(store: Store, scenarioViewer: string, bodyText: string): McpResponse {
  let request: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    request = parsed as Record<string, unknown>;
  } catch {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  const id = request['id'];
  const method = request['method'];
  if (typeof method !== 'string') return { status: 200, body: rpcError(id, -32600, 'Invalid Request') };
  if (id === undefined) {
    // A notification: no response body.
    return { status: 202, body: null };
  }
  const params = request['params'] !== null && typeof request['params'] === 'object' && !Array.isArray(request['params'])
    ? (request['params'] as Record<string, unknown>)
    : {};

  switch (method) {
    case 'server/discover':
      return {
        status: 200,
        body: rpcResult(id, {
          supportedVersions: [...PROTOCOL_VERSIONS],
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        }),
      };
    case 'initialize': {
      const protocolVersion = typeof params['protocolVersion'] === 'string' ? params['protocolVersion'] : PROTOCOL_VERSIONS[0];
      return {
        status: 200,
        body: rpcResult(id, {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        }),
      };
    }
    case 'ping':
      return { status: 200, body: rpcResult(id, {}) };
    case 'tools/list':
      return { status: 200, body: rpcResult(id, { tools: TOOLS }) };
    case 'tools/call': {
      const name = params['name'];
      if (typeof name !== 'string') return { status: 200, body: rpcError(id, -32602, 'Invalid params: tool name is required') };
      const args = params['arguments'] !== null && typeof params['arguments'] === 'object' && !Array.isArray(params['arguments'])
        ? (params['arguments'] as Record<string, unknown>)
        : {};
      const known = TOOLS.some((tool) => tool['name'] === name);
      if (!known) return { status: 200, body: rpcError(id, -32601, `Unknown tool: ${name}`) };
      const result = callTool(store, scenarioViewer, name, args);
      return { status: 200, body: rpcResult(id, result) };
    }
    default:
      return { status: 200, body: rpcError(id, -32601, `Method not found: ${method}`) };
  }
}
