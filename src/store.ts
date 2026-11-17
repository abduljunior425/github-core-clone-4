// The store: one content-addressed object map shared by every repository, plus
// the per-repository REST state (issues, pull requests, labels, refs). Git
// objects are immutable and hashed on write, so a clone, a REST contents
// commit and a squash merge all read and write the same objects; the REST
// surface never invents a commit id — every commit sha is the real SHA-1 of
// the commit object bytes it stores.

import { hashObject, isOid, lineCount, opaqueId, TrialClock, ZERO_OID } from './util.ts';

export type GitType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitType;
  data: Buffer;
}

export interface CommitMeta {
  tree: string;
  parents: string[];
  message: string;
  author: string;
  committer: string;
  timestamp: number;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export interface FlatEntry {
  mode: string;
  oid: string;
}

export interface CommentRec {
  id: number;
  nodeId: string;
  body: string;
  userLogin: string;
  createdAt: string;
  updatedAt: string;
}

export interface IssueRec {
  id: number;
  nodeId: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  userLogin: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  comments: CommentRec[];
  seq: number;
  jsonCache: string | null;
}

export interface PullFile {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

export interface PullRec {
  id: number;
  nodeId: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeSha: string | null;
  files: PullFile[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  seq: number;
}

export interface LabelRec {
  name: string;
  color: string;
  description: string;
}

export interface Repo {
  dbId: number;
  nodeId: string;
  name: string;
  owner: string | null;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  refs: Map<string, string>;
  refVersion: number;
  packCache: Map<string, Buffer>;
  issues: IssueRec[];
  issueByNumber: Map<number, IssueRec>;
  issueSeq: number;
  pulls: PullRec[];
  pullByNumber: Map<number, PullRec>;
  pullSeq: number;
  labels: Map<string, LabelRec>;
  commentSeq: number;
  createdAt: string;
  updatedAt: string;
  pushedAt: string | null;
}

export const MAIN_BRANCH = 'main';
export const FORGE_IDENTITY = 'Forge <forge@localhost>';

function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/** Serialize tree entries in git's order. */
export function buildTreeData(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Parse one commit object's headers. */
export function parseCommit(data: Buffer): CommitMeta {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headerText = data.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  let timestamp = 0;
  const stamp = /(\d+) [+-]\d{4}$/.exec(author);
  if (stamp !== null) timestamp = Number(stamp[1]);
  return { tree, parents, message, author, committer, timestamp };
}

/** Serialize a commit object from its fields. */
export function buildCommitData(fields: {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  timestamp: number;
  message: string;
}): Buffer {
  const lines: string[] = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author} ${fields.timestamp} +0000`);
  lines.push(`committer ${fields.committer} ${fields.timestamp} +0000`);
  lines.push('', fields.message.endsWith('\n') ? fields.message : `${fields.message}\n`);
  return Buffer.from(lines.join('\n'), 'utf8');
}

/** Parse one tree object's entries. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) break;
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

/** Parse one annotated tag object's headers. */
export function parseTag(data: Buffer): { object: string; type: string; tag: string; tagger: string } {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headers = new Map<string, string>();
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    const space = line.indexOf(' ');
    if (space > 0) headers.set(line.slice(0, space), line.slice(space + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: headers.get('type') ?? '',
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
  };
}

/** Added/removed line counts between two blob versions (prefix/suffix diff). */
export function diffLineCounts(oldData: Buffer, newData: Buffer): { additions: number; deletions: number } {
  const oldLines = oldData.length === 0 ? [] : oldData.toString('utf8').split('\n');
  const newLines = newData.length === 0 ? [] : newData.toString('utf8').split('\n');
  if (oldLines.length > 0 && oldLines[oldLines.length - 1] === '') oldLines.pop();
  if (newLines.length > 0 && newLines[newLines.length - 1] === '') newLines.pop();
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return {
    additions: newLines.length - prefix - suffix,
    deletions: oldLines.length - prefix - suffix,
  };
}

export class Store {
  readonly clock = new TrialClock();
  readonly token: string;
  viewerLogin: string | null = null;

  readonly objects = new Map<string, GitObject>();
  private readonly commitCache = new Map<string, CommitMeta | null>();
  private readonly treeCache = new Map<string, TreeEntry[] | null>();
  private readonly treeMapCache = new Map<string, Map<string, FlatEntry>>();
  private readonly commitSeq = new Map<string, number>();
  private seqCounter = 0;

  readonly repos = new Map<string, Repo>();
  private nextDbId = 1;
  private nextRestId = 1;
  private nextReqId = 1;

  constructor(token: string) {
    this.token = token;
  }

  nextRequestId(): string {
    const id = this.nextReqId;
    this.nextReqId += 1;
    return `forge4-req-${id}`;
  }

  nextRestIdNum(): number {
    const id = this.nextRestId;
    this.nextRestId += 1;
    return id;
  }

  /** Store an object (deduplicated by id); returns its id. */
  putObject(type: GitType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) {
      this.objects.set(oid, { type, data });
      if (type === 'commit') {
        this.seqCounter += 1;
        this.commitSeq.set(oid, this.seqCounter);
      }
    }
    return oid;
  }

  getObject(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  hasObject(oid: string): boolean {
    return this.objects.has(oid);
  }

  getCommit(oid: string): CommitMeta | null {
    let meta = this.commitCache.get(oid);
    if (meta === undefined) {
      const object = this.objects.get(oid);
      meta = object !== undefined && object.type === 'commit' ? parseCommit(object.data) : null;
      this.commitCache.set(oid, meta);
    }
    return meta;
  }

  getTree(oid: string): TreeEntry[] | null {
    let entries = this.treeCache.get(oid);
    if (entries === undefined) {
      const object = this.objects.get(oid);
      entries = object !== undefined && object.type === 'tree' ? parseTree(object.data) : null;
      this.treeCache.set(oid, entries);
    }
    return entries;
  }

  /** Flatten a tree object into path -> entry, recursively. */
  treeMap(treeOid: string): Map<string, FlatEntry> {
    const cached = this.treeMapCache.get(treeOid);
    if (cached !== undefined) return cached;
    const out = new Map<string, FlatEntry>();
    const walk = (oid: string, prefix: string): void => {
      const entries = this.getTree(oid);
      if (entries === null) return;
      for (const entry of entries) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { mode: entry.mode, oid: entry.oid });
      }
    };
    walk(treeOid, '');
    this.treeMapCache.set(treeOid, out);
    return out;
  }

  /** Build (and store) a tree object from a flat path map. */
  buildTreeFromMap(entries: ReadonlyMap<string, FlatEntry>): string {
    const build = (prefix: string): string => {
      const files: TreeEntry[] = [];
      const dirs = new Set<string>();
      for (const [path, entry] of entries) {
        if (prefix !== '' && !path.startsWith(`${prefix}/`)) continue;
        const rest = prefix === '' ? path : path.slice(prefix.length + 1);
        const slash = rest.indexOf('/');
        if (slash < 0) {
          files.push({ mode: entry.mode, name: rest, oid: entry.oid });
        } else {
          dirs.add(rest.slice(0, slash));
        }
      }
      const treeEntries: TreeEntry[] = [...files];
      for (const dir of [...dirs].sort()) {
        treeEntries.push({ mode: '40000', name: dir, oid: build(prefix === '' ? dir : `${prefix}/${dir}`) });
      }
      return this.putObject('tree', buildTreeData(treeEntries));
    };
    return build('');
  }

  /** True when `ancestor` is reachable from `tip` through parent links. */
  isAncestor(ancestor: string, tip: string): boolean {
    if (ancestor === tip) return true;
    const seen = new Set<string>();
    const queue: string[] = [tip];
    while (queue.length > 0) {
      const oid = queue.pop() as string;
      if (oid === ancestor) return true;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const meta = this.getCommit(oid);
      if (meta !== null) for (const parent of meta.parents) queue.push(parent);
    }
    return false;
  }

  /** The newest common ancestor of two commits, or null. */
  mergeBase(a: string, b: string): string | null {
    const ancestorsA = new Set<string>();
    const queueA: string[] = [a];
    while (queueA.length > 0) {
      const oid = queueA.pop() as string;
      if (ancestorsA.has(oid)) continue;
      ancestorsA.add(oid);
      const meta = this.getCommit(oid);
      if (meta !== null) for (const parent of meta.parents) queueA.push(parent);
    }
    const queueB: string[] = [b];
    const seenB = new Set<string>();
    let best: string | null = null;
    let bestSeq = -1;
    while (queueB.length > 0) {
      const oid = queueB.pop() as string;
      if (seenB.has(oid)) continue;
      seenB.add(oid);
      if (ancestorsA.has(oid)) {
        const seq = this.commitSeq.get(oid) ?? 0;
        if (seq > bestSeq) {
          bestSeq = seq;
          best = oid;
        }
      }
      const meta = this.getCommit(oid);
      if (meta !== null) for (const parent of meta.parents) queueB.push(parent);
    }
    return best;
  }

  /**
   * Every object id reachable from `tips`: commits (with parents and trees),
   * tags (with their target) and trees (with entries). A commit in `stopAt`
   * is included but its parents are not walked (a shallow boundary).
   */
  collectReachable(tips: Iterable<string>, stopAt?: ReadonlySet<string>): Set<string> {
    const seen = new Set<string>();
    const queue: string[] = [];
    for (const tip of tips) if (isOid(tip) && tip !== ZERO_OID) queue.push(tip);
    while (queue.length > 0) {
      const oid = queue.pop() as string;
      if (seen.has(oid)) continue;
      const object = this.objects.get(oid);
      if (object === undefined) continue;
      seen.add(oid);
      if (object.type === 'commit') {
        const meta = this.getCommit(oid);
        if (meta === null) continue;
        queue.push(meta.tree);
        if (stopAt === undefined || !stopAt.has(oid)) for (const parent of meta.parents) queue.push(parent);
      } else if (object.type === 'tag') {
        queue.push(parseTag(object.data).object);
      } else if (object.type === 'tree') {
        const entries = this.getTree(oid);
        if (entries !== null) for (const entry of entries) queue.push(entry.oid);
      }
    }
    return seen;
  }

  /** Commits reachable from `tip`, newest first (by store sequence). */
  listCommits(tip: string): string[] {
    const seen = this.collectReachable([tip]);
    const commits: string[] = [];
    for (const oid of seen) if (this.objects.get(oid)?.type === 'commit') commits.push(oid);
    commits.sort((a, b) => (this.commitSeq.get(b) ?? 0) - (this.commitSeq.get(a) ?? 0));
    return commits;
  }

  /** Resolve a branch name, full ref or oid to a commit oid, or null. */
  resolveRef(repo: Repo, ref: string): string | null {
    if (isOid(ref)) return this.hasObject(ref) ? ref : null;
    if (ref.startsWith('refs/')) {
      const oid = repo.refs.get(ref);
      return oid !== undefined ? oid : null;
    }
    const oid = repo.refs.get(`refs/heads/${ref}`);
    return oid !== undefined ? oid : null;
  }

  /** The tip of a branch name, or null. */
  branchTip(repo: Repo, branch: string): string | null {
    const oid = repo.refs.get(`refs/heads/${branch}`);
    return oid !== undefined ? oid : null;
  }

  /** Drop every cached pack for a repository (called on any ref change). */
  invalidateRepo(repo: Repo): void {
    repo.refVersion += 1;
    repo.packCache.clear();
  }

  createRepo(name: string, description: string, isPrivate: boolean): Repo {
    const dbId = this.nextDbId;
    this.nextDbId += 1;
    const { iso } = this.clock.next();
    const repo: Repo = {
      dbId,
      nodeId: opaqueId('Repository', dbId),
      name,
      owner: null,
      description,
      isPrivate,
      defaultBranch: MAIN_BRANCH,
      refs: new Map(),
      refVersion: 0,
      packCache: new Map(),
      issues: [],
      issueByNumber: new Map(),
      issueSeq: 1,
      pulls: [],
      pullByNumber: new Map(),
      pullSeq: 1,
      labels: new Map(),
      commentSeq: 1,
      createdAt: iso,
      updatedAt: iso,
      pushedAt: null,
    };
    this.repos.set(name, repo);
    return repo;
  }

  /** Remove a repository from the registry (its git objects stay, harmlessly). */
  deleteRepo(repo: Repo): void {
    this.repos.delete(repo.name);
  }

  /** Create an issue, numbered from 1 per repository. */
  createIssue(repo: Repo, input: { title: string; body: string | null; labels: string[] }): IssueRec {
    const number = repo.issueSeq;
    repo.issueSeq += 1;
    const { iso } = this.clock.next();
    const issue: IssueRec = {
      id: this.nextRestIdNum(),
      nodeId: opaqueId('Issue', repo.dbId, number),
      number,
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      labels: [...input.labels],
      userLogin: repo.owner ?? this.viewer(),
      createdAt: iso,
      updatedAt: iso,
      closedAt: null,
      comments: [],
      seq: number,
      jsonCache: null,
    };
    repo.issues.push(issue);
    repo.issueByNumber.set(number, issue);
    return issue;
  }

  /** Append a comment to an issue; clears the issue's cached JSON. */
  createComment(repo: Repo, issue: IssueRec, body: string): CommentRec {
    const id = repo.commentSeq;
    repo.commentSeq += 1;
    const { iso } = this.clock.next();
    const comment: CommentRec = {
      id,
      nodeId: opaqueId('IssueComment', repo.dbId, issue.number, id),
      body,
      userLogin: repo.owner ?? this.viewer(),
      createdAt: iso,
      updatedAt: iso,
    };
    issue.comments.push(comment);
    issue.jsonCache = null;
    return comment;
  }

  /** Create a pull request, snapshotting the base-vs-head file diff. */
  createPull(
    repo: Repo,
    input: { title: string; body: string | null; headRef: string; baseRef: string; headSha: string; baseSha: string },
  ): PullRec {
    const number = repo.pullSeq;
    repo.pullSeq += 1;
    const { iso } = this.clock.next();
    const baseTreeOid = this.getCommit(input.baseSha)?.tree ?? ZERO_OID;
    const headTreeOid = this.getCommit(input.headSha)?.tree ?? ZERO_OID;
    const pull: PullRec = {
      id: this.nextRestIdNum(),
      nodeId: opaqueId('PullRequest', repo.dbId, number),
      number,
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      headRef: input.headRef,
      baseRef: input.baseRef,
      headSha: input.headSha,
      baseSha: input.baseSha,
      merged: false,
      mergedAt: null,
      mergeSha: null,
      files: diffToPullFiles(this, baseTreeOid, headTreeOid),
      createdAt: iso,
      updatedAt: iso,
      closedAt: null,
      seq: number,
    };
    repo.pulls.push(pull);
    repo.pullByNumber.set(number, pull);
    return pull;
  }

  /** Create a commit from a flat tree map and point `refName` at it. */
  createCommitOnBranch(
    repo: Repo,
    refName: string,
    entries: ReadonlyMap<string, FlatEntry>,
    message: string,
    parents: string[],
  ): string {
    const treeOid = this.buildTreeFromMap(entries);
    const { epochSec } = this.clock.next();
    const commitOid = this.putObject(
      'commit',
      buildCommitData({ tree: treeOid, parents, author: FORGE_IDENTITY, committer: FORGE_IDENTITY, timestamp: epochSec, message }),
    );
    repo.refs.set(refName, commitOid);
    this.invalidateRepo(repo);
    return commitOid;
  }

  /** True when head and base both changed the same path differently since their merge base. */
  pullConflicts(repo: Repo, pull: PullRec): boolean {
    const baseTip = this.branchTip(repo, pull.baseRef);
    if (baseTip === null) return true;
    const baseTreeOid = this.getCommit(baseTip)?.tree ?? null;
    const headTreeOid = this.getCommit(pull.headSha)?.tree ?? null;
    if (baseTreeOid === null || headTreeOid === null) return true;
    const mergeBaseOid = this.mergeBase(baseTip, pull.headSha);
    if (mergeBaseOid === null) return true;
    const mergeBaseTreeOid = this.getCommit(mergeBaseOid)?.tree ?? null;
    if (mergeBaseTreeOid === null) return true;
    const baseTree = this.treeMap(baseTreeOid);
    const headTree = this.treeMap(headTreeOid);
    const ancestorTree = this.treeMap(mergeBaseTreeOid);
    for (const [path, ancestorEntry] of ancestorTree) {
      const baseEntry = baseTree.get(path);
      const headEntry = headTree.get(path);
      const baseChanged = baseEntry === undefined || baseEntry.oid !== ancestorEntry.oid;
      const headChanged = headEntry === undefined || headEntry.oid !== ancestorEntry.oid;
      if (baseChanged && headChanged && (baseEntry?.oid ?? null) !== (headEntry?.oid ?? null)) return true;
    }
    for (const [path, headEntry] of headTree) {
      if (ancestorTree.has(path)) continue;
      const baseEntry = baseTree.get(path);
      if (baseEntry !== undefined && baseEntry.oid !== headEntry.oid) return true;
    }
    return false;
  }

  /** Squash-merge a pull request onto its base branch. */
  squashMergePull(repo: Repo, pull: PullRec): { ok: true; sha: string } | { ok: false; reason: string } {
    if (pull.merged) return { ok: true, sha: pull.mergeSha as string };
    if (pull.state !== 'open') return { ok: false, reason: 'pull request is not open' };
    if (this.pullConflicts(repo, pull)) return { ok: false, reason: 'merge conflict' };
    const baseTip = this.branchTip(repo, pull.baseRef) as string;
    const baseTreeOid = this.getCommit(baseTip)?.tree as string;
    const headTreeOid = this.getCommit(pull.headSha)?.tree as string;
    const mergeBaseOid = this.mergeBase(baseTip, pull.headSha) as string;
    const mergeBaseTreeOid = this.getCommit(mergeBaseOid)?.tree as string;
    const baseTree = this.treeMap(baseTreeOid);
    const headTree = this.treeMap(headTreeOid);
    const ancestorTree = this.treeMap(mergeBaseTreeOid);
    const merged = new Map<string, FlatEntry>(baseTree);
    for (const [path, ancestorEntry] of ancestorTree) {
      const headEntry = headTree.get(path);
      if (headEntry !== undefined && headEntry.oid !== ancestorEntry.oid) merged.set(path, headEntry);
      else if (headEntry === undefined && baseTree.get(path)?.oid === ancestorEntry.oid) merged.delete(path);
    }
    for (const [path, headEntry] of headTree) {
      if (!ancestorTree.has(path)) merged.set(path, headEntry);
    }
    const message = `Merge pull request #${pull.number} from ${pull.headRef}`;
    const mergeSha = this.createCommitOnBranch(repo, `refs/heads/${pull.baseRef}`, merged, message, [baseTip]);
    pull.state = 'closed';
    pull.merged = true;
    const { iso } = this.clock.next();
    pull.mergedAt = iso;
    pull.mergeSha = mergeSha;
    pull.closedAt = iso;
    pull.updatedAt = iso;
    return { ok: true, sha: mergeSha };
  }

  /**
   * Find a repository by name under `owner`. A repository created through
   * POST /user/repos has no owner until the first owner-bearing read binds
   * it to the token's login; a different owner afterwards is a 404, never a 403.
   */
  findRepo(owner: string, name: string): Repo | null {
    const repo = this.repos.get(name);
    if (repo === undefined) return null;
    if (repo.owner === null) {
      repo.owner = owner;
      if (this.viewerLogin === null) this.viewerLogin = owner;
    }
    if (repo.owner !== owner) return null;
    return repo;
  }

  /** The login the token names, once any owner-bearing request has bound it. */
  viewer(): string {
    return this.viewerLogin ?? '';
  }
}

/** The changed paths between two trees, with old/new entries. */
export function diffTrees(
  store: Store,
  baseTreeOid: string,
  headTreeOid: string,
): Map<string, { oldEntry?: FlatEntry; newEntry?: FlatEntry }> {
  const base = baseTreeOid === ZERO_OID ? new Map<string, FlatEntry>() : store.treeMap(baseTreeOid);
  const head = headTreeOid === ZERO_OID ? new Map<string, FlatEntry>() : store.treeMap(headTreeOid);
  const out = new Map<string, { oldEntry?: FlatEntry; newEntry?: FlatEntry }>();
  for (const [path, entry] of base) {
    const other = head.get(path);
    if (other === undefined || other.oid !== entry.oid) out.set(path, { oldEntry: entry, newEntry: other });
  }
  for (const [path, entry] of head) {
    if (!base.has(path)) out.set(path, { newEntry: entry });
  }
  return out;
}

/** The pull-request file list for a tree diff, with line counts. */
export function diffToPullFiles(
  store: Store,
  baseTreeOid: string,
  headTreeOid: string,
): PullFile[] {
  const diff = diffTrees(store, baseTreeOid, headTreeOid);
  const files: PullFile[] = [];
  for (const [path, change] of [...diff.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (change.oldEntry === undefined && change.newEntry !== undefined) {
      const blob = store.getObject(change.newEntry.oid);
      const additions = blob === undefined ? 0 : lineCount(blob.data);
      files.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (change.oldEntry !== undefined && change.newEntry === undefined) {
      const blob = store.getObject(change.oldEntry.oid);
      const deletions = blob === undefined ? 0 : lineCount(blob.data);
      files.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (change.oldEntry !== undefined && change.newEntry !== undefined) {
      const oldBlob = store.getObject(change.oldEntry.oid);
      const newBlob = store.getObject(change.newEntry.oid);
      const counts =
        oldBlob === undefined || newBlob === undefined
          ? { additions: 0, deletions: 0 }
          : diffLineCounts(oldBlob.data, newBlob.data);
      files.push({
        filename: path,
        status: 'modified',
        additions: counts.additions,
        deletions: counts.deletions,
        changes: counts.additions + counts.deletions,
      });
    }
  }
  return files;
}
