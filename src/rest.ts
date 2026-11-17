// REST API v3. All state lives in the shared store, so git, GraphQL and MCP
// see exactly what REST wrote.
//
// Determinism: every timestamp comes from the store's trial clock, ids and
// numbers are counters, and no handler reads the wall clock or randomness.
// The read workload (2,000 GETs of one issue) is served from the issue's
// cached JSON string, invalidated on any mutation of that issue.

import {
  decodePath,
  isOid,
  opaqueId,
} from './util.ts';
import {
  FORGE_IDENTITY,
  parseTag,
  type CommentRec,
  type FlatEntry,
  type IssueRec,
  type PullRec,
  type Repo,
  type Store,
} from './store.ts';

export interface RestRequest {
  method: string;
  /** Path after the /api/v3 prefix, always starting with '/'. */
  path: string;
  query: URLSearchParams;
  body: unknown;
  /** Request Host header, for absolute pagination URLs. */
  host: string;
}

export interface RestResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
  /** When set, the body is already serialized JSON; send it as-is. */
  rawBody?: string;
}

const ok = (body: unknown, status = 200, headers?: Record<string, string>): RestResponse => ({ status, body, headers });
const err = (status: number, message: string): RestResponse => ({ status, body: { message } });

function bodyObject(body: unknown): Record<string, unknown> {
  return body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

function bodyString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === 'string' ? value : undefined;
}

function bodyBoolean(body: Record<string, unknown>, key: string): boolean | undefined {
  const value = body[key];
  return typeof value === 'boolean' ? value : undefined;
}

function pageParams(query: URLSearchParams): { page: number; perPage: number } {
  const perPageRaw = Number.parseInt(query.get('per_page') ?? '', 10);
  const pageRaw = Number.parseInt(query.get('page') ?? '', 10);
  return {
    perPage: Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30,
    page: Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1,
  };
}

function paginate<T>(items: readonly T[], page: number, perPage: number): T[] {
  return items.slice((page - 1) * perPage, page * perPage);
}

function pageLinks(req: RestRequest, total: number, page: number, perPage: number): string {
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  const parts: string[] = [];
  const urlFor = (pageNumber: number): string => {
    const query = new URLSearchParams(req.query);
    query.set('page', String(pageNumber));
    query.set('per_page', String(perPage));
    return `http://${req.host}/api/v3${req.path}?${query.toString()}`;
  };
  if (page < lastPage) parts.push(`<${urlFor(page + 1)}>; rel="next"`);
  if (page > 1) parts.push(`<${urlFor(page - 1)}>; rel="prev"`);
  if (lastPage > 1) {
    parts.push(`<${urlFor(1)}>; rel="first"`);
    parts.push(`<${urlFor(lastPage)}>; rel="last"`);
  }
  return parts.join(', ');
}

// -------------------------------------------------------------------------------------------
// Serializers
// -------------------------------------------------------------------------------------------

function repoJson(store: Store, repo: Repo, host: string): Record<string, unknown> {
  const owner = repo.owner ?? store.viewer();
  return {
    id: repo.dbId,
    node_id: repo.nodeId,
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    owner: { login: owner, id: repo.dbId, node_id: repo.nodeId, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.pushedAt,
    html_url: `https://github.com/${owner}/${repo.name}`,
    url: `http://${host}/api/v3/repos/${owner}/${repo.name}`,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    has_pages: false,
    archived: false,
    disabled: false,
    license: null,
    topics: [],
    visibility: repo.isPrivate ? 'private' : 'public',
  };
}

function labelJson(repo: Repo, name: string): Record<string, unknown> {
  const label = repo.labels.get(name);
  const names = [...repo.labels.keys()];
  return {
    id: names.indexOf(name) + 1,
    node_id: opaqueId('Label', repo.dbId, name),
    name,
    color: label?.color ?? '000000',
    description: label?.description ?? '',
    default: false,
  };
}

function issueJson(repo: Repo, issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: issue.nodeId,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    user: { login: issue.userLogin, type: 'User' },
    labels: issue.labels.map((name) => labelJson(repo, name)),
    assignee: null,
    assignees: [],
    milestone: null,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    author_association: 'OWNER',
    html_url: `https://github.com/${repo.owner ?? ''}/${repo.name}/issues/${issue.number}`,
  };
}

/** The serialized issue JSON, cached on the record until it is mutated. */
function issueJsonString(repo: Repo, issue: IssueRec): string {
  if (repo.owner !== null && issue.jsonCache !== null) return issue.jsonCache;
  const json = JSON.stringify(issueJson(repo, issue));
  if (repo.owner !== null) issue.jsonCache = json;
  return json;
}

function commentJson(repo: Repo, issueNumber: number, comment: CommentRec): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: comment.nodeId,
    body: comment.body,
    user: { login: comment.userLogin, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    html_url: `https://github.com/${repo.owner ?? ''}/${repo.name}/issues/${issueNumber}#issuecomment-${comment.id}`,
  };
}

function pullJson(store: Store, repo: Repo, pull: PullRec): Record<string, unknown> {
  const owner = repo.owner ?? '';
  return {
    id: pull.id,
    node_id: pull.nodeId,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    user: { login: owner, type: 'User' },
    labels: [],
    head: { ref: pull.headRef, sha: pull.headSha, label: `${owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${owner}:${pull.baseRef}` },
    merged: pull.merged,
    mergeable: pull.merged ? null : !store.pullConflicts(repo, pull),
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeSha,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.closedAt,
    draft: false,
    html_url: `https://github.com/${owner}/${repo.name}/pull/${pull.number}`,
  };
}

function commitJson(store: Store, sha: string): Record<string, unknown> {
  const meta = store.getCommit(sha);
  const date = meta === null ? '' : new Date(meta.timestamp * 1000).toISOString();
  // GitHub strips the commit object's trailing newline in the API.
  const message = (meta?.message ?? '').replace(/\n$/, '');
  return {
    sha,
    commit: {
      message,
      author: { name: FORGE_IDENTITY.split(' <')[0], email: 'forge@localhost', date },
      committer: { name: FORGE_IDENTITY.split(' <')[0], email: 'forge@localhost', date },
    },
    parents: (meta?.parents ?? []).map((parent) => ({ sha: parent })),
  };
}

// -------------------------------------------------------------------------------------------
// Router
// -------------------------------------------------------------------------------------------

export function handleRest(store: Store, req: RestRequest): RestResponse {
  const segments = decodePath(req.path);
  const method = req.method;

  if (segments.length === 0) {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok({}, 200, { 'X-OAuth-Scopes': 'repo, read:org' });
  }
  if (segments.length === 1 && segments[0] === 'meta') {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok({ installed_version: '1.0.0', verifiable_password_authentication: true });
  }
  if (segments.length === 1 && segments[0] === 'user') {
    if (method !== 'GET') return err(404, 'Not Found');
    const login = store.viewerLogin;
    if (login === null) return err(404, 'Not Found');
    return ok({ login, id: 1, node_id: opaqueId('User', 1), type: 'User', site_admin: false });
  }
  if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'GET') return listUserRepos(store, req);
    if (method === 'POST') return createUserRepo(store, req);
    return err(404, 'Not Found');
  }
  if (segments.length >= 2 && segments[0] === 'repos') {
    return handleRepoRoutes(store, req, segments.slice(1));
  }
  return err(404, 'Not Found');
}

// -------------------------------------------------------------------------------------------
// /user/repos
// -------------------------------------------------------------------------------------------

function listUserRepos(store: Store, req: RestRequest): RestResponse {
  const repos = [...store.repos.values()].sort((a, b) => a.dbId - b.dbId);
  const { page, perPage } = pageParams(req.query);
  const links = pageLinks(req, repos.length, page, perPage);
  return ok(paginate(repos, page, perPage).map((repo) => repoJson(store, repo, req.host)), 200, links === '' ? undefined : { Link: links });
}

function createUserRepo(store: Store, req: RestRequest): RestResponse {
  const body = bodyObject(req.body);
  const name = bodyString(body, 'name');
  if (name === undefined || name.trim() === '') return err(422, 'name is required');
  if (store.repos.has(name)) return err(422, 'Repository already exists');
  const repo = store.createRepo(name, bodyString(body, 'description') ?? '', bodyBoolean(body, 'private') ?? false);
  return ok(repoJson(store, repo, req.host), 201);
}

// -------------------------------------------------------------------------------------------
// /repos/{owner}/{name}/...
// -------------------------------------------------------------------------------------------

function handleRepoRoutes(store: Store, req: RestRequest, segments: string[]): RestResponse {
  if (segments.length < 2) return err(404, 'Not Found');
  const owner = segments[0] as string;
  const name = segments[1] as string;
  const repo = store.findRepo(owner, name);
  if (repo === null) return err(404, 'Not Found');
  const rest = segments.slice(2);
  const method = req.method;

  if (rest.length === 0) {
    if (method === 'GET') return ok(repoJson(store, repo, req.host));
    if (method === 'PATCH') {
      const body = bodyObject(req.body);
      const description = bodyString(body, 'description');
      if (description !== undefined) repo.description = description;
      const isPrivate = bodyBoolean(body, 'private');
      if (isPrivate !== undefined) repo.isPrivate = isPrivate;
      repo.updatedAt = store.clock.next().iso;
      return ok(repoJson(store, repo, req.host));
    }
    if (method === 'DELETE') {
      store.deleteRepo(repo);
      return { status: 204, body: null };
    }
    return err(404, 'Not Found');
  }

  const head = rest[0] as string;
  if (head === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const branches = [...repo.refs.keys()]
        .filter((ref) => ref.startsWith('refs/heads/'))
        .map((ref) => ref.slice('refs/heads/'.length))
        .sort()
        .map((branch) => ({ name: branch, commit: { sha: repo.refs.get(`refs/heads/${branch}`) as string } }));
      return ok(branches);
    }
    if (rest.length === 2 && method === 'GET') {
      const sha = repo.refs.get(`refs/heads/${rest[1] as string}`);
      if (sha === undefined) return err(404, 'Not Found');
      return ok({ name: rest[1], commit: { sha } });
    }
    return err(404, 'Not Found');
  }

  if (head === 'git' && rest[1] === 'refs') {
    if (rest.length === 2 && method === 'POST') return createGitRef(store, repo, req);
    if (rest.length >= 4 && rest[2] === 'heads' && method === 'GET') {
      const branch = rest.slice(3).join('/');
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (sha === undefined) return err(404, 'Not Found');
      return ok({ ref: `refs/heads/${branch}`, object: { sha, type: 'commit' } });
    }
    return err(404, 'Not Found');
  }

  if (head === 'commits' && rest.length === 1 && method === 'GET') {
    const refArg = req.query.get('sha');
    const tip = resolveRefArg(store, repo, refArg);
    if (tip === null) return err(404, 'Not Found');
    return ok(store.listCommits(tip).map((sha) => commitJson(store, sha)));
  }

  if (head === 'contents') {
    const path = rest.slice(1).join('/');
    if (method === 'GET') return getContents(store, repo, req, path);
    if (method === 'PUT') return putContents(store, repo, req, path);
    if (method === 'DELETE') return deleteContents(store, repo, req, path);
    return err(404, 'Not Found');
  }

  if (head === 'labels') {
    if (rest.length === 1 && method === 'GET') {
      return ok([...repo.labels.keys()].map((labelName) => labelJson(repo, labelName)));
    }
    if (rest.length === 1 && method === 'POST') {
      const body = bodyObject(req.body);
      const labelName = bodyString(body, 'name');
      const color = bodyString(body, 'color') ?? '000000';
      if (labelName === undefined || labelName.trim() === '') return err(422, 'name is required');
      if (repo.labels.has(labelName)) return err(422, 'Label already exists');
      repo.labels.set(labelName, { name: labelName, color, description: '' });
      return ok(labelJson(repo, labelName), 201);
    }
    return err(404, 'Not Found');
  }

  if (head === 'issues') {
    if (rest.length === 1 && method === 'GET') return listIssues(repo, req);
    if (rest.length === 1 && method === 'POST') return createIssue(store, repo, req);
    const number = Number.parseInt(rest[1] ?? '', 10);
    if (!Number.isInteger(number) || number < 1) return err(404, 'Not Found');
    const issue = repo.issueByNumber.get(number);
    if (issue === undefined) return err(404, 'Not Found');
    if (rest.length === 2 && method === 'GET') {
      return { status: 200, body: null, rawBody: issueJsonString(repo, issue) };
    }
    if (rest.length === 2 && method === 'PATCH') return patchIssue(store, repo, issue, req);
    if (rest.length === 3 && rest[2] === 'comments' && method === 'GET') {
      return ok(issue.comments.map((comment) => commentJson(repo, issue.number, comment)));
    }
    if (rest.length === 3 && rest[2] === 'comments' && method === 'POST') {
      const body = bodyObject(req.body);
      const commentBody = bodyString(body, 'body');
      if (commentBody === undefined) return err(422, 'body is required');
      const comment = store.createComment(repo, issue, commentBody);
      return ok(commentJson(repo, issue.number, comment), 201);
    }
    return err(404, 'Not Found');
  }

  if (head === 'pulls') {
    if (rest.length === 1 && method === 'GET') return listPulls(store, repo, req);
    if (rest.length === 1 && method === 'POST') return createPull(store, repo, req);
    const number = Number.parseInt(rest[1] ?? '', 10);
    if (!Number.isInteger(number) || number < 1) return err(404, 'Not Found');
    const pull = repo.pullByNumber.get(number);
    if (pull === undefined) return err(404, 'Not Found');
    if (rest.length === 2 && method === 'GET') return ok(pullJson(store, repo, pull));
    if (rest.length === 3 && rest[2] === 'files' && method === 'GET') return ok(pull.files);
    if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') return mergePull(store, repo, pull);
    return err(404, 'Not Found');
  }

  return err(404, 'Not Found');
}

// -------------------------------------------------------------------------------------------
// git refs
// -------------------------------------------------------------------------------------------

function createGitRef(store: Store, repo: Repo, req: RestRequest): RestResponse {
  const body = bodyObject(req.body);
  const ref = bodyString(body, 'ref');
  const sha = bodyString(body, 'sha');
  if (ref === undefined || !ref.startsWith('refs/')) return err(422, 'ref must start with refs/');
  if (sha === undefined || !isOid(sha)) return err(422, 'sha is required');
  if (repo.refs.has(ref)) return err(422, 'Reference already exists');
  if (!store.hasObject(sha)) return err(422, 'Object does not exist');
  repo.refs.set(ref, sha);
  store.invalidateRepo(repo);
  return ok({ ref, object: { sha, type: 'commit' } }, 201);
}

// -------------------------------------------------------------------------------------------
// contents
// -------------------------------------------------------------------------------------------

/** Resolve a ref argument (branch name or commit sha) to a tip commit oid. */
function resolveRefArg(store: Store, repo: Repo, refArg: string | null): string | null {
  if (refArg === null) return store.branchTip(repo, repo.defaultBranch);
  if (isOid(refArg)) return store.getObject(refArg)?.type === 'commit' ? refArg : null;
  const tip = store.branchTip(repo, refArg);
  if (tip !== null) return tip;
  const tagOid = repo.refs.get(`refs/tags/${refArg}`);
  if (tagOid !== undefined) {
    const object = store.getObject(tagOid);
    if (object?.type === 'tag') return parseTag(object.data).object;
    return tagOid;
  }
  return null;
}

function getContents(store: Store, repo: Repo, req: RestRequest, path: string): RestResponse {
  const tip = resolveRefArg(store, repo, req.query.get('ref'));
  if (tip === null) return err(404, 'Not Found');
  const treeOid = store.getCommit(tip)?.tree ?? null;
  if (treeOid === null) return err(404, 'Not Found');
  const flat = store.treeMap(treeOid);
  const entry = flat.get(path);
  if (entry !== undefined) {
    const blob = store.getObject(entry.oid);
    if (blob === undefined) return err(404, 'Not Found');
    return ok({
      type: 'file',
      encoding: 'base64',
      size: blob.data.length,
      name: path.split('/').pop() ?? path,
      path,
      content: blob.data.toString('base64'),
      sha: entry.oid,
    });
  }
  const prefix = path === '' ? '' : `${path}/`;
  const children = new Map<string, { kind: 'file' | 'dir'; oid: string }>();
  for (const [childPath, childEntry] of flat) {
    if (prefix !== '' && !childPath.startsWith(prefix)) continue;
    const rest = prefix === '' ? childPath : childPath.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) {
      children.set(rest, { kind: 'file', oid: childEntry.oid });
    } else {
      const dir = rest.slice(0, slash);
      if (!children.has(dir)) {
        const sub = new Map<string, FlatEntry>();
        for (const [subPath, subEntry] of flat) {
          if (subPath.startsWith(`${prefix}${dir}/`)) sub.set(subPath.slice(prefix.length + dir.length + 1), subEntry);
        }
        children.set(dir, { kind: 'dir', oid: store.buildTreeFromMap(sub) });
      }
    }
  }
  if (children.size === 0) return err(404, 'Not Found');
  const listing = [...children.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([childName, child]) => ({
      type: child.kind,
      name: childName,
      path: prefix === '' ? childName : `${prefix}${childName}`,
      sha: child.oid,
    }));
  return ok(listing);
}

function putContents(store: Store, repo: Repo, req: RestRequest, path: string): RestResponse {
  const body = bodyObject(req.body);
  const message = bodyString(body, 'message') ?? 'Update file';
  const contentB64 = bodyString(body, 'content');
  if (contentB64 === undefined) return err(422, 'content is required');
  let content: Buffer;
  try {
    content = Buffer.from(contentB64, 'base64');
  } catch {
    return err(422, 'content must be base64');
  }
  const branch = bodyString(body, 'branch') ?? repo.defaultBranch;
  const refName = `refs/heads/${branch}`;
  let tip = repo.refs.get(refName);
  if (tip === undefined && branch !== repo.defaultBranch) {
    tip = store.branchTip(repo, repo.defaultBranch);
  }
  const baseTreeOid = tip === undefined ? null : store.getCommit(tip)?.tree ?? null;
  // treeMap returns a cached map: copy before mutating it.
  const flat = baseTreeOid === null ? new Map<string, FlatEntry>() : new Map(store.treeMap(baseTreeOid));
  const existing = flat.get(path);
  const providedSha = bodyString(body, 'sha');
  if (providedSha !== undefined) {
    if (existing === undefined || existing.oid !== providedSha) return err(409, 'sha does not match the current file');
  }
  const blobOid = store.putObject('blob', content);
  flat.set(path, { mode: '100644', oid: blobOid });
  const commitOid = store.createCommitOnBranch(repo, refName, flat, message, tip === undefined ? [] : [tip]);
  return ok(
    {
      content: { name: path.split('/').pop() ?? path, path, sha: blobOid, size: content.length, encoding: 'base64', type: 'file' },
      commit: { sha: commitOid, message },
    },
    existing === undefined ? 201 : 200,
  );
}

function deleteContents(store: Store, repo: Repo, req: RestRequest, path: string): RestResponse {
  const body = bodyObject(req.body);
  const message = bodyString(body, 'message') ?? 'Delete file';
  const branch = bodyString(body, 'branch') ?? repo.defaultBranch;
  const refName = `refs/heads/${branch}`;
  const tip = repo.refs.get(refName);
  if (tip === undefined) return err(404, 'Not Found');
  const treeOid = store.getCommit(tip)?.tree ?? null;
  if (treeOid === null) return err(404, 'Not Found');
  // treeMap returns a cached map: copy before mutating it.
  const flat = new Map(store.treeMap(treeOid));
  const existing = flat.get(path);
  if (existing === undefined) return err(404, 'Not Found');
  const providedSha = bodyString(body, 'sha');
  if (providedSha !== undefined && providedSha !== existing.oid) return err(409, 'sha does not match the current file');
  flat.delete(path);
  const commitOid = store.createCommitOnBranch(repo, refName, flat, message, [tip]);
  return ok({ commit: { sha: commitOid, message } }, 200);
}

// -------------------------------------------------------------------------------------------
// issues
// -------------------------------------------------------------------------------------------

function listIssues(repo: Repo, req: RestRequest): RestResponse {
  const state = req.query.get('state') ?? 'open';
  const direction = req.query.get('direction') ?? 'desc';
  let issues = [...repo.issues];
  if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
  else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
  else if (state !== 'all') issues = issues.filter((issue) => issue.state === 'open');
  issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
  const { page, perPage } = pageParams(req.query);
  const links = pageLinks(req, issues.length, page, perPage);
  return ok(paginate(issues, page, perPage).map((issue) => issueJson(repo, issue)), 200, links === '' ? undefined : { Link: links });
}

function createIssue(store: Store, repo: Repo, req: RestRequest): RestResponse {
  const body = bodyObject(req.body);
  const title = bodyString(body, 'title');
  if (title === undefined || title.trim() === '') return err(422, 'title is required');
  const labelsRaw = body['labels'];
  const labels: string[] = Array.isArray(labelsRaw)
    ? labelsRaw
        .map((label) =>
          typeof label === 'string' ? label : typeof label === 'object' && label !== null ? (label as Record<string, unknown>)['name'] : undefined,
        )
        .filter((label): label is string => typeof label === 'string')
    : [];
  for (const label of labels) {
    if (!repo.labels.has(label)) return err(422, `Label "${label}" does not exist`);
  }
  const issue = store.createIssue(repo, { title, body: bodyString(body, 'body') ?? null, labels });
  return ok(issueJson(repo, issue), 201);
}

function patchIssue(store: Store, repo: Repo, issue: IssueRec, req: RestRequest): RestResponse {
  const body = bodyObject(req.body);
  const state = bodyString(body, 'state');
  if (state !== undefined) {
    if (state !== 'open' && state !== 'closed') return err(422, 'state must be open or closed');
    issue.state = state;
    issue.closedAt = state === 'closed' ? store.clock.next().iso : null;
  }
  const title = bodyString(body, 'title');
  if (title !== undefined) issue.title = title;
  const bodyText = bodyString(body, 'body');
  if (bodyText !== undefined) issue.body = bodyText;
  issue.updatedAt = store.clock.next().iso;
  issue.jsonCache = null;
  return ok(issueJson(repo, issue));
}

// -------------------------------------------------------------------------------------------
// pulls
// -------------------------------------------------------------------------------------------

function listPulls(store: Store, repo: Repo, req: RestRequest): RestResponse {
  const state = req.query.get('state') ?? 'open';
  let pulls = [...repo.pulls];
  if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
  else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
  else if (state !== 'all') pulls = pulls.filter((pull) => pull.state === 'open');
  pulls.sort((a, b) => b.number - a.number);
  const { page, perPage } = pageParams(req.query);
  const links = pageLinks(req, pulls.length, page, perPage);
  return ok(paginate(pulls, page, perPage).map((pull) => pullJson(store, repo, pull)), 200, links === '' ? undefined : { Link: links });
}

function createPull(store: Store, repo: Repo, req: RestRequest): RestResponse {
  const body = bodyObject(req.body);
  const title = bodyString(body, 'title');
  const head = bodyString(body, 'head');
  const base = bodyString(body, 'base');
  if (title === undefined || title.trim() === '') return err(422, 'title is required');
  if (head === undefined || base === undefined) return err(422, 'head and base are required');
  const headSha = store.branchTip(repo, head);
  const baseSha = store.branchTip(repo, base);
  if (headSha === null || baseSha === null) return err(422, 'head or base branch does not exist');
  for (const existing of repo.pulls) {
    if (existing.state === 'open' && existing.headRef === head && existing.baseRef === base) {
      return err(422, 'A pull request already exists for this head and base');
    }
  }
  const pull = store.createPull(repo, {
    title,
    body: bodyString(body, 'body') ?? null,
    headRef: head,
    baseRef: base,
    headSha,
    baseSha,
  });
  return ok(pullJson(store, repo, pull), 201);
}

/** Merge a pull request with a squash commit; 405 when the branches conflict. */
function mergePull(store: Store, repo: Repo, pull: PullRec): RestResponse {
  if (pull.merged) {
    return ok({ sha: pull.mergeSha, merged: true, message: 'Pull request already merged' });
  }
  if (pull.state !== 'open') return err(409, 'Pull request is not open');
  const result = store.squashMergePull(repo, pull);
  if (!result.ok) return err(405, 'Merge conflict');
  return ok({ sha: result.sha, merged: true, message: `Merge pull request #${pull.number} from ${pull.headRef}` });
}
