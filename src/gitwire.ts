// Git smart HTTP: info/refs advertisements (v0 and v2), protocol-v2 ls-refs
// and fetch, protocol-v0 fetch, and receive-pack.
//
// The v2 capability advertisement is a constant. Every fetch response is
// served from the repository's pack cache (see gitpack.ts), so fifty
// concurrent shallow clones of one tip share one built pack.

import { parseTag, type Repo, type Store } from './store.ts';
import { cachedFetch, parsePack, type FetchRequest } from './gitpack.ts';
import { isOid, pktDelim, pktFlush, pktLine, parsePktLines, ZERO_OID, type Pkt } from './util.ts';

export type GitService = 'git-upload-pack' | 'git-receive-pack';

const AGENT = 'forge4/1.0';

const V2_ADVERTISEMENT: Buffer = Buffer.concat([
  pktLine('version 2\n'),
  pktLine(`agent=${AGENT}\n`),
  pktLine('ls-refs\n'),
  pktLine('fetch=shallow\n'),
  pktLine('object-format=sha1\n'),
  pktFlush(),
]);

const UPLOAD_V0_CAPS = `side-band-64k thin-pack ofs-delta multi_ack multi_ack_detailed shallow symref=HEAD:refs/heads/main agent=${AGENT}`;
const RECEIVE_V0_CAPS = `report-status side-band-64k delete-refs ofs-delta symref=HEAD:refs/heads/main agent=${AGENT}`;

/** Refs sorted by name, with a peeled commit for annotated tags. */
function refLines(store: Store, repo: Repo): Array<{ name: string; oid: string; peeled?: string }> {
  const out: Array<{ name: string; oid: string; peeled?: string }> = [];
  for (const name of [...repo.refs.keys()].sort()) {
    const oid = repo.refs.get(name) as string;
    const entry: { name: string; oid: string; peeled?: string } = { name, oid };
    if (name.startsWith('refs/tags/')) {
      const object = store.getObject(oid);
      if (object !== undefined && object.type === 'tag') {
        const target = parseTag(object.data).object;
        if (store.getObject(target)?.type === 'commit') entry.peeled = target;
      }
    }
    out.push(entry);
  }
  return out;
}

/** A v0 ref advertisement: service preamble, flush, ref lines, flush. */
function v0Advertisement(store: Store, repo: Repo, service: GitService): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_V0_CAPS : RECEIVE_V0_CAPS;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  const refs = refLines(store, repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const headOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    let first = true;
    if (headOid !== undefined) {
      parts.push(pktLine(`${headOid} HEAD\0${caps}\n`));
      first = false;
    }
    for (const ref of refs) {
      const line = `${ref.oid} ${ref.name}`;
      parts.push(pktLine(first ? `${line}\0${caps}\n` : `${line}\n`));
      first = false;
      if (ref.peeled !== undefined) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** The info/refs answer for a service; null when the repository is missing. */
export function infoRefsBody(store: Store, repo: Repo, service: GitService, isV2: boolean): Buffer | null {
  if (service === 'git-upload-pack' && isV2) return V2_ADVERTISEMENT;
  return v0Advertisement(store, repo, service);
}

export function infoRefsContentType(service: GitService): string {
  return `application/x-${service}-advertisement`;
}

// -------------------------------------------------------------------------------------------
// ls-refs (protocol v2)
// -------------------------------------------------------------------------------------------

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function lsRefsResponse(store: Store, repo: Repo, args: LsRefsArgs): Buffer {
  const parts: Buffer[] = [];
  const headTarget = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headTarget);
  const refs = refLines(store, repo);
  const prefixOk = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  // HEAD is listed when no prefix filters, or when a prefix matches HEAD
  // (a real clone asks for ref-prefix HEAD alongside refs/heads/ and
  // refs/tags/; without the HEAD line it cannot resolve the default branch).
  if (prefixOk('HEAD')) {
    if (headOid !== undefined) {
      parts.push(pktLine(args.symrefs ? `${headOid} HEAD symref-target:${headTarget}\n` : `${headOid} HEAD\n`));
    } else if (args.unborn) {
      parts.push(pktLine(`unborn HEAD symref-target:${headTarget}\n`));
    }
  }
  for (const ref of refs) {
    if (!prefixOk(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (args.peel && ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// -------------------------------------------------------------------------------------------
// fetch (protocol v2 and v0)
// -------------------------------------------------------------------------------------------

function parseFetchV2(packets: Pkt[]): FetchRequest {
  let command: string | null = null;
  let afterDelim = false;
  const req: FetchRequest = { wants: [], haves: [], shallow: [] };
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!afterDelim) {
      if (line.startsWith('command=')) command = line.slice('command='.length);
      continue;
    }
    if (line.startsWith('want ')) req.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) req.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) req.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const depth = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(depth) && depth > 0) req.depth = depth;
    }
    // thin-pack, no-progress, ofs-delta, filter, deepen-since, deepen-not, done: accepted, no action.
  }
  if (command !== 'fetch') throw new Error(`expected command=fetch, got ${JSON.stringify(command)}`);
  return req;
}

function parseFetchV0(body: Buffer): FetchRequest {
  const packets = parsePktLines(body);
  const req: FetchRequest = { wants: [], haves: [], shallow: [] };
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (section === 0) {
      if (line.startsWith('want ')) req.wants.push(line.slice(5).split(' ')[0] as string);
      else if (line.startsWith('shallow ')) req.shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) {
        const depth = Number.parseInt(line.slice(7).trim(), 10);
        if (Number.isFinite(depth) && depth > 0) req.depth = depth;
      }
    } else if (line.startsWith('have ')) {
      req.haves.push(line.slice(5).trim());
    }
    // done: no action.
  }
  if (req.wants.length === 0) throw new Error('a v0 fetch needs at least one want');
  return req;
}

/** Handle POST /{owner}/{repo}.git/git-upload-pack; returns the response bytes. */
export function handleUploadPack(store: Store, repo: Repo, body: Buffer, isV2: boolean): Buffer {
  if (isV2) {
    const packets = parsePktLines(body);
    let command: string | null = null;
    for (const packet of packets) {
      if (packet.kind !== 'data') continue;
      const line = packet.payload.toString('utf8').replace(/\n$/, '');
      if (line.startsWith('command=')) {
        command = line.slice('command='.length);
        break;
      }
    }
    if (command === 'ls-refs') {
      const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
      let afterDelim = false;
      for (const packet of packets) {
        if (packet.kind === 'delim') {
          afterDelim = true;
          continue;
        }
        if (packet.kind !== 'data' || !afterDelim) continue;
        const line = packet.payload.toString('utf8').replace(/\n$/, '');
        if (line === 'peel') args.peel = true;
        else if (line === 'symrefs') args.symrefs = true;
        else if (line === 'unborn') args.unborn = true;
        else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
      }
      return lsRefsResponse(store, repo, args);
    }
    if (command === 'fetch') {
      const req = parseFetchV2(packets);
      return cachedFetch(store, repo, 2, req);
    }
    throw new Error(`unknown upload-pack command ${JSON.stringify(command)}`);
  }
  const req = parseFetchV0(body);
  return cachedFetch(store, repo, 0, req);
}

// -------------------------------------------------------------------------------------------
// receive-pack (protocol v0)
// -------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

interface PushOutcome {
  ref: string;
  ok: boolean;
  reason: string;
}

/**
 * Split a receive-pack body at its first flush pkt-line: the command list
 * before it, the pack bytes after it.
 */
function splitReceivePack(body: Buffer): { commands: PushCommand[]; pack: Buffer } {
  const commands: PushCommand[] = [];
  let offset = 0;
  let packStart = body.length;
  while (offset + 4 <= body.length) {
    const head = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error(`bad pkt-line length ${JSON.stringify(head)}`);
    const length = Number.parseInt(head, 16);
    if (length === 0) {
      packStart = offset + 4;
      break;
    }
    if (length === 1 || length === 2) {
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > body.length) throw new Error('pkt-line length runs past the body');
    const line = body.subarray(offset + 4, offset + length).toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    const text = nul >= 0 ? line.slice(0, nul) : line;
    const parts = text.split(' ');
    if (parts.length !== 3 || !isOid(parts[0] as string) || !isOid(parts[1] as string)) {
      throw new Error(`bad receive-pack command ${JSON.stringify(text.slice(0, 60))}`);
    }
    commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
    offset += length;
  }
  if (commands.length === 0) throw new Error('a receive-pack needs at least one command');
  return { commands, pack: body.subarray(packStart) };
}

/**
 * Handle POST /{owner}/{repo}.git/git-receive-pack. Always answers HTTP 200
 * with a sideband report-status stream: a refused ref is an `ng` line, never
 * an HTTP error.
 */
export function handleReceivePack(store: Store, repo: Repo, body: Buffer): Buffer {
  let commands: PushCommand[] = [];
  let pack = Buffer.alloc(0);
  let unpackError: string | null = null;
  try {
    const split = splitReceivePack(body);
    commands = split.commands;
    pack = split.pack;
  } catch (err) {
    unpackError = err instanceof Error ? err.message : String(err);
  }

  const outcomes: PushOutcome[] = [];
  if (unpackError === null) {
    if (pack.length > 0) {
      try {
        for (const object of parsePack(pack, store)) store.putObject(object.type, object.data);
      } catch (err) {
        unpackError = err instanceof Error ? err.message : String(err);
      }
    }
    if (unpackError === null) {
      let changed = false;
      for (const command of commands) {
        const outcome = applyPushCommand(store, repo, command);
        outcomes.push(outcome);
        if (outcome.ok) changed = true;
      }
      if (changed) {
        store.invalidateRepo(repo);
        const { iso } = store.clock.next();
        repo.pushedAt = iso;
      }
    } else {
      for (const command of commands) outcomes.push({ ref: command.ref, ok: false, reason: 'unpack failed' });
    }
  } else {
    for (const command of commands) outcomes.push({ ref: command.ref, ok: false, reason: 'unpack failed' });
    if (commands.length === 0) outcomes.push({ ref: 'refs/heads/main', ok: false, reason: 'unpack failed' });
  }

  const reportParts: Buffer[] = [];
  reportParts.push(pktLine(unpackError === null ? 'unpack ok\n' : `unpack ${unpackError}\n`));
  for (const outcome of outcomes) {
    reportParts.push(pktLine(outcome.ok ? `ok ${outcome.ref}\n` : `ng ${outcome.ref} ${outcome.reason}\n`));
  }
  reportParts.push(pktFlush());
  const report = Buffer.concat(reportParts);
  const out: Buffer[] = [];
  for (let offset = 0; offset < report.length; offset += 32768) {
    const chunk = report.subarray(offset, Math.min(report.length, offset + 32768));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  out.push(pktFlush());
  return Buffer.concat(out);
}

/** Validate and apply one ref update; a refusal never moves the ref. */
function applyPushCommand(store: Store, repo: Repo, command: PushCommand): PushOutcome {
  const current = repo.refs.get(command.ref);
  if (command.newOid === ZERO_OID) {
    if (current === undefined) return { ref: command.ref, ok: false, reason: 'reference does not exist' };
    if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
      return { ref: command.ref, ok: false, reason: 'non-fast-forward' };
    }
    repo.refs.delete(command.ref);
    return { ref: command.ref, ok: true, reason: '' };
  }
  if (!store.hasObject(command.newOid)) return { ref: command.ref, ok: false, reason: 'object not found' };
  if (command.oldOid === ZERO_OID) {
    if (current !== undefined) return { ref: command.ref, ok: false, reason: 'already exists' };
    repo.refs.set(command.ref, command.newOid);
    return { ref: command.ref, ok: true, reason: '' };
  }
  if (current === undefined) return { ref: command.ref, ok: false, reason: 'reference does not exist' };
  if (command.oldOid !== current) return { ref: command.ref, ok: false, reason: 'non-fast-forward' };
  if (command.newOid === current) return { ref: command.ref, ok: true, reason: '' };
  if (!store.isAncestor(command.oldOid, command.newOid)) {
    return { ref: command.ref, ok: false, reason: 'non-fast-forward' };
  }
  repo.refs.set(command.ref, command.newOid);
  return { ref: command.ref, ok: true, reason: '' };
}
