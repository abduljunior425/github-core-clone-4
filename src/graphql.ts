// GraphQL over /api/graphql: a small parser and executor for the document
// set the suite sends. No schema is generated at runtime; the resolver map
// below is the schema, and unknown fields error with the GraphQL message
// format (`Cannot query field "x" on type "Y".`) at HTTP 200.
//
// Global ids are the same opaque ids REST uses, so `node(id:)` round-trips
// repositories, issues and pull requests created through any surface.

import { decodeOpaqueId } from './util.ts';
import { type IssueRec, type PullRec, type Repo, type Store } from './store.ts';

// -------------------------------------------------------------------------------------------
// AST
// -------------------------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selections: SelectionNode[] | null;
}

type SelectionNode =
  | FieldNode
  | { kind: 'fragmentSpread'; name: string }
  | { kind: 'inlineFragment'; typeCondition: string | null; selections: SelectionNode[] };

interface OperationNode {
  kind: 'query' | 'mutation';
  name: string | null;
  variableDefinitions: Array<{ name: string; defaultValue: ValueNode | null }>;
  selections: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, SelectionNode[]>;
}

// -------------------------------------------------------------------------------------------
// Tokenizer
// -------------------------------------------------------------------------------------------

interface Token {
  kind: 'name' | 'string' | 'int' | 'float' | 'punct' | 'spread';
  value: string;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}():$!=@[]'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let value = '';
      i += 1;
      while (i < source.length && source[i] !== '"') {
        const c = source[i] as string;
        if (c === '\\' && i + 1 < source.length) {
          const esc = source[i + 1] as string;
          const simple: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          if (esc === 'u' && i + 5 < source.length) {
            value += String.fromCharCode(Number.parseInt(source.slice(i + 2, i + 6), 16));
            i += 6;
          } else {
            value += simple[esc] ?? esc;
            i += 2;
          }
        } else {
          value += c;
          i += 1;
        }
      }
      i += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      let isFloat = false;
      if (source[j] === '.' && /[0-9]/.test(source[j + 1] ?? '')) {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`Unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

// -------------------------------------------------------------------------------------------
// Parser
// -------------------------------------------------------------------------------------------

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('Unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`Expected "${value}", got ${JSON.stringify(token.value)}`);
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name' || (value !== undefined && token.value !== value)) {
      throw new Error(`Expected name ${value ?? ''}, got ${JSON.stringify(token.value)}`);
    }
    return token.value;
  }

  private atPunct(value: string): boolean {
    const token = this.peek();
    return token !== undefined && token.kind === 'punct' && token.value === value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, SelectionNode[]>();
    while (this.pos < this.tokens.length) {
      const token = this.peek() as Token;
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ kind: 'query', name: null, variableDefinitions: [], selections: this.parseSelectionSet() });
      } else if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        const kind = this.next().value as 'query' | 'mutation';
        let name: string | null = null;
        if (this.peek()?.kind === 'name') name = this.next().value;
        const variableDefinitions = this.atPunct('(') ? this.parseVariableDefinitions() : [];
        this.skipDirectives();
        operations.push({ kind, name, variableDefinitions, selections: this.parseSelectionSet() });
      } else if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName('on');
        this.expectName();
        this.skipDirectives();
        fragments.set(name, this.parseSelectionSet());
      } else {
        throw new Error(`Unexpected token ${JSON.stringify(token.value)} at the top of a GraphQL document`);
      }
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): Array<{ name: string; defaultValue: ValueNode | null }> {
    const defs: Array<{ name: string; defaultValue: ValueNode | null }> = [];
    this.expectPunct('(');
    while (!this.atPunct(')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      this.parseType();
      let defaultValue: ValueNode | null = null;
      if (this.atPunct('=')) {
        this.next();
        defaultValue = this.parseValue();
      }
      this.skipDirectives();
      defs.push({ name, defaultValue });
    }
    this.expectPunct(')');
    return defs;
  }

  private parseType(): void {
    if (this.atPunct('[')) {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.atPunct('!')) this.next();
  }

  private skipDirectives(): void {
    while (this.atPunct('@')) {
      this.next();
      this.expectName();
      if (this.atPunct('(')) this.parseArguments();
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.atPunct('}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek() as Token;
    if (token.kind === 'spread') {
      this.next();
      const next = this.peek() as Token;
      if (next.kind === 'name' && next.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'inlineFragment', typeCondition, selections: this.parseSelectionSet() };
      }
      if (next.kind === 'name') {
        const name = this.next().value;
        this.skipDirectives();
        return { kind: 'fragmentSpread', name };
      }
      this.skipDirectives();
      return { kind: 'inlineFragment', typeCondition: null, selections: this.parseSelectionSet() };
    }
    const name = this.expectName();
    let alias: string | null = null;
    let fieldName = name;
    if (this.atPunct(':')) {
      this.next();
      alias = name;
      fieldName = this.expectName();
    }
    const args = this.atPunct('(') ? this.parseArguments() : [];
    this.skipDirectives();
    const selections = this.atPunct('{') ? this.parseSelectionSet() : null;
    return { kind: 'field', alias, name: fieldName, args, selections };
  }

  private parseArguments(): Array<{ name: string; value: ValueNode }> {
    const args: Array<{ name: string; value: ValueNode }> = [];
    this.expectPunct('(');
    while (!this.atPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!this.atPunct(']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!this.atPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`Unexpected value token ${JSON.stringify(token.value)}`);
  }
}

// -------------------------------------------------------------------------------------------
// Value resolution
// -------------------------------------------------------------------------------------------

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((child) => resolveValue(child, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function resolveArgs(args: Array<{ name: string; value: ValueNode }>, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of args) out[arg.name] = resolveValue(arg.value, variables);
  return out;
}

// -------------------------------------------------------------------------------------------
// Object wrappers (every resolved object carries its GraphQL type name)
// -------------------------------------------------------------------------------------------

type GqlObject = Record<string, unknown> & { __typename: string };

function userObject(login: string): GqlObject {
  return { __typename: 'User', login, id: `User:${login}` };
}

function repoObject(repo: Repo): GqlObject {
  return { __typename: 'Repository', repo };
}

function issueObject(repo: Repo, issue: IssueRec): GqlObject {
  return { __typename: 'Issue', repo, issue };
}

function pullObject(repo: Repo, pull: PullRec): GqlObject {
  return { __typename: 'PullRequest', repo, pull };
}

function pageInfoObject(hasNextPage: boolean, endCursor: string | null, startCursor: string | null): GqlObject {
  return { __typename: 'PageInfo', hasNextPage, hasPreviousPage: false, endCursor, startCursor };
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64url');
}

function cursorNumber(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? null : Number.parseInt(match[1], 10);
  } catch {
    return null;
  }
}

function issueState(issue: IssueRec): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: PullRec): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

// -------------------------------------------------------------------------------------------
// Introspection data (the __type answers)
// -------------------------------------------------------------------------------------------

interface TypeInfo {
  kind: 'OBJECT' | 'ENUM';
  fields: string[];
  enumValues: string[];
}

const TYPE_INFO: Record<string, TypeInfo> = {
  Query: {
    kind: 'OBJECT',
    fields: ['viewer', 'repository', 'node', 'search', '__type', '__schema'],
    enumValues: [],
  },
  Mutation: {
    kind: 'OBJECT',
    fields: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
    enumValues: [],
  },
  User: {
    kind: 'OBJECT',
    fields: ['id', 'login', 'name', 'email', 'url', 'avatarUrl', 'repositories'],
    enumValues: [],
  },
  Repository: {
    kind: 'OBJECT',
    fields: [
      'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled',
      'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'createdAt', 'updatedAt', 'pushedAt', 'defaultBranch',
    ],
    enumValues: [],
  },
  Issue: {
    kind: 'OBJECT',
    fields: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'closedAt', 'author', 'labels', 'comments', 'url', 'repository'],
    enumValues: [],
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: [
      'id', 'number', 'title', 'body', 'state', 'headRefName', 'baseRefName', 'mergeable', 'merged', 'files',
      'createdAt', 'updatedAt', 'closedAt', 'author', 'url', 'repository',
    ],
    enumValues: [],
  },
  IssueConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'], enumValues: [] },
  PullRequestConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'], enumValues: [] },
  PageInfo: { kind: 'OBJECT', fields: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'], enumValues: [] },
  Ref: { kind: 'OBJECT', fields: ['id', 'name', 'target'], enumValues: [] },
  IssueComment: { kind: 'OBJECT', fields: ['id', 'body', 'author', 'createdAt', 'updatedAt'], enumValues: [] },
  IssueCommentEdge: { kind: 'OBJECT', fields: ['node', 'cursor'], enumValues: [] },
  PullRequestChangedFile: { kind: 'OBJECT', fields: ['path', 'additions', 'deletions', 'changes'], enumValues: [] },
  SearchType: { kind: 'ENUM', fields: [], enumValues: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'] },
  IssueState: { kind: 'ENUM', fields: [], enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', fields: [], enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', fields: [], enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
};

// -------------------------------------------------------------------------------------------
// Execution
// -------------------------------------------------------------------------------------------

interface ExecContext {
  store: Store;
  fragments: Map<string, SelectionNode[]>;
  errors: Array<{ message: string }>;
}

type Resolver = (ctx: ExecContext, obj: GqlObject, args: Record<string, unknown>) => unknown;

function repoByDbId(store: Store, dbId: number): Repo | null {
  for (const repo of store.repos.values()) if (repo.dbId === dbId) return repo;
  return null;
}

function issuesConnection(ctx: ExecContext, repo: Repo, args: Record<string, unknown>): GqlObject {
  let items = [...repo.issues];
  const states = args['states'];
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state).toLowerCase()));
    items = items.filter((issue) => wanted.has(issue.state));
  }
  const orderBy = args['orderBy'];
  let direction = 'ASC';
  if (orderBy !== null && typeof orderBy === 'object') {
    const dir = (orderBy as Record<string, unknown>)['direction'];
    if (typeof dir === 'string') direction = dir.toUpperCase();
  }
  items.sort((a, b) => (direction === 'DESC' ? b.number - a.number : a.number - b.number));
  const after = cursorNumber(args['after']);
  if (after !== null) {
    const index = items.findIndex((issue) => issue.number === after);
    if (index >= 0) items = items.slice(index + 1);
  }
  const first = typeof args['first'] === 'number' ? args['first'] : items.length;
  const page = items.slice(0, Math.max(0, first));
  const hasNextPage = items.length > page.length;
  const endCursor = page.length > 0 ? cursorFor((page[page.length - 1] as IssueRec).number) : null;
  const startCursor = page.length > 0 ? cursorFor((page[0] as IssueRec).number) : null;
  return {
    __typename: 'IssueConnection',
    nodes: page.map((issue) => issueObject(repo, issue)),
    pageInfo: pageInfoObject(hasNextPage, endCursor, startCursor),
    totalCount: repo.issues.length,
  };
}

function pullsConnection(ctx: ExecContext, repo: Repo, args: Record<string, unknown>): GqlObject {
  let items = [...repo.pulls];
  const states = args['states'];
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state).toUpperCase()));
    items = items.filter((pull) => wanted.has(pullState(pull)));
  } else {
    items = items.filter((pull) => pull.state === 'open');
  }
  items.sort((a, b) => a.number - b.number);
  const after = cursorNumber(args['after']);
  if (after !== null) {
    const index = items.findIndex((pull) => pull.number === after);
    if (index >= 0) items = items.slice(index + 1);
  }
  const first = typeof args['first'] === 'number' ? args['first'] : items.length;
  const page = items.slice(0, Math.max(0, first));
  const hasNextPage = items.length > page.length;
  const endCursor = page.length > 0 ? cursorFor((page[page.length - 1] as PullRec).number) : null;
  const startCursor = page.length > 0 ? cursorFor((page[0] as PullRec).number) : null;
  return {
    __typename: 'PullRequestConnection',
    nodes: page.map((pull) => pullObject(repo, pull)),
    pageInfo: pageInfoObject(hasNextPage, endCursor, startCursor),
    totalCount: repo.pulls.length,
  };
}

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: (ctx) => userObject(ctx.store.viewer()),
    repository: (ctx, _obj, args) => {
      const owner = args['owner'];
      const name = args['name'];
      if (typeof owner !== 'string' || typeof name !== 'string') return null;
      const repo = ctx.store.findRepo(owner, name);
      return repo === null ? null : repoObject(repo);
    },
    node: (ctx, _obj, args) => {
      const id = args['id'];
      if (typeof id !== 'string') return null;
      const decoded = decodeOpaqueId(id);
      if (decoded === null) return null;
      const parts = decoded.split(':');
      if (parts[0] === 'Repository' && parts.length === 2) {
        const repo = repoByDbId(ctx.store, Number(parts[1]));
        return repo === null ? null : repoObject(repo);
      }
      if (parts[0] === 'Issue' && parts.length === 3) {
        const repo = repoByDbId(ctx.store, Number(parts[1]));
        const issue = repo?.issueByNumber.get(Number(parts[2]));
        return repo !== null && repo !== undefined && issue !== undefined ? issueObject(repo, issue) : null;
      }
      if (parts[0] === 'PullRequest' && parts.length === 3) {
        const repo = repoByDbId(ctx.store, Number(parts[1]));
        const pull = repo?.pullByNumber.get(Number(parts[2]));
        return repo !== null && repo !== undefined && pull !== undefined ? pullObject(repo, pull) : null;
      }
      return null;
    },
    __type: (_ctx, _obj, args) => {
      const name = args['name'];
      if (typeof name !== 'string') return null;
      const info = TYPE_INFO[name];
      if (info === undefined) return null;
      return { __typename: '__Type', name, kind: info.kind };
    },
    __schema: () => ({ __typename: '__Schema', queryType: { name: 'Query' }, mutationType: { name: 'Mutation' }, types: [] }),
  },
  Mutation: {
    createIssue: (ctx, _obj, args) => {
      const input = (args['input'] ?? {}) as Record<string, unknown>;
      const repositoryId = input['repositoryId'];
      if (typeof repositoryId !== 'string') return null;
      const decoded = decodeOpaqueId(repositoryId);
      const parts = decoded?.split(':') ?? [];
      if (parts[0] !== 'Repository' || parts.length !== 2) return null;
      const repo = repoByDbId(ctx.store, Number(parts[1]));
      if (repo === null) return null;
      const title = input['title'];
      if (typeof title !== 'string') return null;
      const issue = ctx.store.createIssue(repo, { title, body: typeof input['body'] === 'string' ? input['body'] : null, labels: [] });
      return { __typename: 'CreateIssuePayload', issue: issueObject(repo, issue) };
    },
    closeIssue: (ctx, _obj, args) => {
      const input = (args['input'] ?? {}) as Record<string, unknown>;
      const issueId = input['issueId'];
      if (typeof issueId !== 'string') return null;
      const decoded = decodeOpaqueId(issueId);
      const parts = decoded?.split(':') ?? [];
      if (parts[0] !== 'Issue' || parts.length !== 3) return null;
      const repo = repoByDbId(ctx.store, Number(parts[1]));
      const issue = repo?.issueByNumber.get(Number(parts[2]));
      if (repo === undefined || repo === null || issue === undefined) return null;
      issue.state = 'closed';
      issue.closedAt = ctx.store.clock.next().iso;
      issue.updatedAt = issue.closedAt;
      issue.jsonCache = null;
      return { __typename: 'CloseIssuePayload', issue: issueObject(repo, issue) };
    },
    createPullRequest: (ctx, _obj, args) => {
      const input = (args['input'] ?? {}) as Record<string, unknown>;
      const repositoryId = input['repositoryId'];
      if (typeof repositoryId !== 'string') return null;
      const decoded = decodeOpaqueId(repositoryId);
      const parts = decoded?.split(':') ?? [];
      if (parts[0] !== 'Repository' || parts.length !== 2) return null;
      const repo = repoByDbId(ctx.store, Number(parts[1]));
      if (repo === null) return null;
      const baseRefName = input['baseRefName'];
      const headRefName = input['headRefName'];
      const title = input['title'];
      if (typeof baseRefName !== 'string' || typeof headRefName !== 'string' || typeof title !== 'string') return null;
      const headSha = ctx.store.branchTip(repo, headRefName);
      const baseSha = ctx.store.branchTip(repo, baseRefName);
      if (headSha === null || baseSha === null) {
        ctx.errors.push({ message: 'head or base branch does not exist' });
        return null;
      }
      for (const existing of repo.pulls) {
        if (existing.state === 'open' && existing.headRef === headRefName && existing.baseRef === baseRefName) {
          ctx.errors.push({ message: 'A pull request already exists for this head and base' });
          return null;
        }
      }
      const pull = ctx.store.createPull(repo, {
        title,
        body: typeof input['body'] === 'string' ? input['body'] : null,
        headRef: headRefName,
        baseRef: baseRefName,
        headSha,
        baseSha,
      });
      return { __typename: 'CreatePullRequestPayload', pullRequest: pullObject(repo, pull) };
    },
    mergePullRequest: (ctx, _obj, args) => {
      const input = (args['input'] ?? {}) as Record<string, unknown>;
      const pullRequestId = input['pullRequestId'];
      if (typeof pullRequestId !== 'string') return null;
      const decoded = decodeOpaqueId(pullRequestId);
      const parts = decoded?.split(':') ?? [];
      if (parts[0] !== 'PullRequest' || parts.length !== 3) return null;
      const repo = repoByDbId(ctx.store, Number(parts[1]));
      const pull = repo?.pullByNumber.get(Number(parts[2]));
      if (repo === undefined || repo === null || pull === undefined) return null;
      const result = ctx.store.squashMergePull(repo, pull);
      if (!result.ok) {
        ctx.errors.push({ message: 'Merge conflict' });
        return null;
      }
      return { __typename: 'MergePullRequestPayload', pullRequest: pullObject(repo, pull) };
    },
    addComment: (ctx, _obj, args) => {
      const input = (args['input'] ?? {}) as Record<string, unknown>;
      const subjectId = input['subjectId'];
      const body = input['body'];
      if (typeof subjectId !== 'string' || typeof body !== 'string') return null;
      const decoded = decodeOpaqueId(subjectId);
      const parts = decoded?.split(':') ?? [];
      if (parts[0] !== 'Issue' || parts.length !== 3) return null;
      const repo = repoByDbId(ctx.store, Number(parts[1]));
      const issue = repo?.issueByNumber.get(Number(parts[2]));
      if (repo === undefined || repo === null || issue === undefined) return null;
      const comment = ctx.store.createComment(repo, issue, body);
      return {
        __typename: 'AddCommentPayload',
        commentEdge: {
          __typename: 'IssueCommentEdge',
          node: { __typename: 'IssueComment', id: comment.nodeId, body: comment.body },
          cursor: cursorFor(comment.id),
        },
      };
    },
  },
  User: {
    id: (_ctx, obj) => `User:${String(obj['login'] ?? '')}`,
    login: (_ctx, obj) => obj['login'],
    name: (_ctx, obj) => obj['login'],
  },
  Repository: {
    id: (_ctx, obj) => (obj['repo'] as Repo).nodeId,
    databaseId: (_ctx, obj) => (obj['repo'] as Repo).dbId,
    name: (_ctx, obj) => (obj['repo'] as Repo).name,
    nameWithOwner: (ctx, obj) => `${(obj['repo'] as Repo).owner ?? ctx.store.viewer()}/${(obj['repo'] as Repo).name}`,
    owner: (ctx, obj) => userObject((obj['repo'] as Repo).owner ?? ctx.store.viewer()),
    defaultBranchRef: (_ctx, obj) => ({ __typename: 'Ref', name: (obj['repo'] as Repo).defaultBranch }),
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    description: (_ctx, obj) => (obj['repo'] as Repo).description,
    createdAt: (_ctx, obj) => (obj['repo'] as Repo).createdAt,
    updatedAt: (_ctx, obj) => (obj['repo'] as Repo).updatedAt,
    issue: (_ctx, obj, args) => {
      const repo = obj['repo'] as Repo;
      const number = args['number'];
      if (typeof number !== 'number') return null;
      const issue = repo.issueByNumber.get(number);
      return issue === undefined ? null : issueObject(repo, issue);
    },
    issues: (ctx, obj, args) => issuesConnection(ctx, obj['repo'] as Repo, args),
    pullRequest: (_ctx, obj, args) => {
      const repo = obj['repo'] as Repo;
      const number = args['number'];
      if (typeof number !== 'number') return null;
      const pull = repo.pullByNumber.get(number);
      return pull === undefined ? null : pullObject(repo, pull);
    },
    pullRequests: (ctx, obj, args) => pullsConnection(ctx, obj['repo'] as Repo, args),
  },
  Issue: {
    id: (_ctx, obj) => (obj['issue'] as IssueRec).nodeId,
    number: (_ctx, obj) => (obj['issue'] as IssueRec).number,
    title: (_ctx, obj) => (obj['issue'] as IssueRec).title,
    state: (_ctx, obj) => issueState(obj['issue'] as IssueRec),
    body: (_ctx, obj) => (obj['issue'] as IssueRec).body,
    createdAt: (_ctx, obj) => (obj['issue'] as IssueRec).createdAt,
    updatedAt: (_ctx, obj) => (obj['issue'] as IssueRec).updatedAt,
    closedAt: (_ctx, obj) => (obj['issue'] as IssueRec).closedAt,
  },
  PullRequest: {
    id: (_ctx, obj) => (obj['pull'] as PullRec).nodeId,
    number: (_ctx, obj) => (obj['pull'] as PullRec).number,
    title: (_ctx, obj) => (obj['pull'] as PullRec).title,
    body: (_ctx, obj) => (obj['pull'] as PullRec).body,
    state: (_ctx, obj) => pullState(obj['pull'] as PullRec),
    headRefName: (_ctx, obj) => (obj['pull'] as PullRec).headRef,
    baseRefName: (_ctx, obj) => (obj['pull'] as PullRec).baseRef,
    mergeable: (ctx, obj) => {
      const pull = obj['pull'] as PullRec;
      if (pull.merged) return 'UNKNOWN';
      return ctx.store.pullConflicts(obj['repo'] as Repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
    },
    merged: (_ctx, obj) => (obj['pull'] as PullRec).merged,
    files: (ctx, obj, args) => {
      const pull = obj['pull'] as PullRec;
      const first = typeof args['first'] === 'number' ? args['first'] : pull.files.length;
      const page = pull.files.slice(0, Math.max(0, first));
      const hasNextPage = pull.files.length > page.length;
      const endCursor = page.length > 0 ? cursorFor(page.length) : null;
      return {
        __typename: 'PullRequestChangedFileConnection',
        nodes: page.map((file) => ({ __typename: 'PullRequestChangedFile', path: file.filename, additions: file.additions, deletions: file.deletions, changes: file.changes })),
        pageInfo: pageInfoObject(hasNextPage, endCursor, endCursor),
        totalCount: pull.files.length,
      };
    },
    createdAt: (_ctx, obj) => (obj['pull'] as PullRec).createdAt,
    updatedAt: (_ctx, obj) => (obj['pull'] as PullRec).updatedAt,
    closedAt: (_ctx, obj) => (obj['pull'] as PullRec).closedAt,
  },
  IssueConnection: {
    nodes: (_ctx, obj) => obj['nodes'],
    pageInfo: (_ctx, obj) => obj['pageInfo'],
    totalCount: (_ctx, obj) => obj['totalCount'],
  },
  PullRequestConnection: {
    nodes: (_ctx, obj) => obj['nodes'],
    pageInfo: (_ctx, obj) => obj['pageInfo'],
    totalCount: (_ctx, obj) => obj['totalCount'],
  },
  PullRequestChangedFileConnection: {
    nodes: (_ctx, obj) => obj['nodes'],
    pageInfo: (_ctx, obj) => obj['pageInfo'],
    totalCount: (_ctx, obj) => obj['totalCount'],
  },
  PageInfo: {
    hasNextPage: (_ctx, obj) => obj['hasNextPage'],
    hasPreviousPage: (_ctx, obj) => obj['hasPreviousPage'],
    startCursor: (_ctx, obj) => obj['startCursor'],
    endCursor: (_ctx, obj) => obj['endCursor'],
  },
  Ref: {
    name: (_ctx, obj) => obj['name'],
  },
  IssueComment: {
    id: (_ctx, obj) => obj['id'],
    body: (_ctx, obj) => obj['body'],
  },
  IssueCommentEdge: {
    node: (_ctx, obj) => obj['node'],
    cursor: (_ctx, obj) => obj['cursor'],
  },
  PullRequestChangedFile: {
    path: (_ctx, obj) => obj['path'],
    additions: (_ctx, obj) => obj['additions'],
    deletions: (_ctx, obj) => obj['deletions'],
    changes: (_ctx, obj) => obj['changes'],
  },
  __Type: {
    name: (_ctx, obj) => obj['name'],
    kind: (_ctx, obj) => obj['kind'],
    fields: (_ctx, obj) => {
      const info = TYPE_INFO[String(obj['name'] ?? '')];
      if (info === undefined) return null;
      return info.fields.map((name) => ({ __typename: '__Field', name }));
    },
    enumValues: (_ctx, obj) => {
      const info = TYPE_INFO[String(obj['name'] ?? '')];
      if (info === undefined) return null;
      return info.enumValues.map((name) => ({ __typename: '__EnumValue', name }));
    },
  },
  __Field: {
    name: (_ctx, obj) => obj['name'],
  },
  __EnumValue: {
    name: (_ctx, obj) => obj['name'],
  },
  __Schema: {
    queryType: (_ctx, obj) => obj['queryType'],
    mutationType: (_ctx, obj) => obj['mutationType'],
    types: (_ctx, obj) => obj['types'],
  },
  CreateIssuePayload: {
    issue: (_ctx, obj) => obj['issue'],
  },
  CloseIssuePayload: {
    issue: (_ctx, obj) => obj['issue'],
  },
  CreatePullRequestPayload: {
    pullRequest: (_ctx, obj) => obj['pullRequest'],
  },
  MergePullRequestPayload: {
    pullRequest: (_ctx, obj) => obj['pullRequest'],
  },
  AddCommentPayload: {
    commentEdge: (_ctx, obj) => obj['commentEdge'],
  },
};

function executeSelections(
  ctx: ExecContext,
  parentType: string,
  obj: GqlObject,
  selections: SelectionNode[],
  variables: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'field') {
      const responseKey = selection.alias ?? selection.name;
      if (selection.name === '__typename') {
        out[responseKey] = parentType;
        continue;
      }
      const fields = RESOLVERS[parentType];
      const resolver = fields?.[selection.name];
      if (resolver === undefined) {
        ctx.errors.push({ message: `Cannot query field "${selection.name}" on type "${parentType}".` });
        out[responseKey] = null;
        continue;
      }
      const args = resolveArgs(selection.args, variables);
      let value: unknown;
      try {
        value = resolver(ctx, obj, args);
      } catch (err) {
        ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
        out[responseKey] = null;
        continue;
      }
      out[responseKey] = selection.selections === null ? value : executeValue(ctx, value, selection.selections, variables);
    } else if (selection.kind === 'inlineFragment') {
      if (selection.typeCondition === null || selection.typeCondition === parentType) {
        Object.assign(out, executeSelections(ctx, parentType, obj, selection.selections, variables));
      }
    } else if (selection.kind === 'fragmentSpread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment !== undefined) Object.assign(out, executeSelections(ctx, parentType, obj, fragment, variables));
    }
  }
  return out;
}

function executeValue(ctx: ExecContext, value: unknown, selections: SelectionNode[], variables: Record<string, unknown>): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => executeValue(ctx, item, selections, variables));
  if (typeof value === 'object' && '__typename' in (value as Record<string, unknown>)) {
    const obj = value as GqlObject;
    return executeSelections(ctx, obj.__typename, obj, selections, variables);
  }
  return value;
}

function executeOne(store: Store, request: unknown): Record<string, unknown> {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    return { errors: [{ message: 'GraphQL request must be an object with a query' }] };
  }
  const body = request as Record<string, unknown>;
  const query = body['query'];
  if (typeof query !== 'string' || query.trim() === '') {
    return { errors: [{ message: 'GraphQL query is required' }] };
  }
  let document: DocumentNode;
  try {
    document = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  const variables = body['variables'] !== null && typeof body['variables'] === 'object' && !Array.isArray(body['variables'])
    ? (body['variables'] as Record<string, unknown>)
    : {};
  const operationName = typeof body['operationName'] === 'string' ? body['operationName'] : null;
  let operation = document.operations[0] as OperationNode | undefined;
  if (operationName !== null) {
    operation = document.operations.find((candidate) => candidate.name === operationName);
  }
  if (operation === undefined) {
    return { errors: [{ message: 'No operation to execute' }] };
  }
  const resolvedVariables: Record<string, unknown> = { ...variables };
  for (const definition of operation.variableDefinitions) {
    if (resolvedVariables[definition.name] === undefined && definition.defaultValue !== null) {
      resolvedVariables[definition.name] = resolveValue(definition.defaultValue, variables);
    }
  }
  const ctx: ExecContext = { store, fragments: document.fragments, errors: [] };
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  const root: GqlObject = { __typename: rootType };
  const data = executeSelections(ctx, rootType, root, operation.selections, resolvedVariables);
  const result: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) result['errors'] = ctx.errors;
  return result;
}

/** Handle one GraphQL request body (a single operation or an array of them). */
export function handleGraphQL(store: Store, body: unknown): unknown {
  if (Array.isArray(body)) return body.map((request) => executeOne(store, request));
  return executeOne(store, body);
}
