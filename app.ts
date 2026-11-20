// app.ts — the GitHub-compatible git forge for github-core-clone-01.
//
// One process, one store, four surfaces: git smart HTTP (/{owner}/{repo}.git: upload-pack v2
// fetch and receive-pack v0 push), the REST v3 API (/api/v3), GraphQL (/api/graphql) and the
// Streamable HTTP MCP endpoint (/mcp). main.ts binds the port and drives the trial lifecycle.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

// ---------------------------------------------------------------- object model

const ZERO_OID = '0'.repeat(40);
const HEX40 = /^[0-9a-f]{40}$/;

type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

interface Obj { type: ObjType; data: Buffer; }
interface TreeEntry { mode: string; name: string; oid: string; }
interface BlobRef { oid: string; mode: string; }
interface IssueRow { id: string; number: number; title: string; body: string; state: string; labels: string[]; comments: { id: string; body: string }[]; }
interface PullRow { id: string; number: number; state: string; title: string; body: string; merged: boolean; mergedAt: string; mergeCommitSha: string; head: { ref: string; sha: string }; base: { ref: string; sha: string }; }
interface Repo { owner: string; name: string; private: boolean; description: string; refs: Map<string, string>; objects: Map<string, Obj>; defaultBranch: string; labels: Set<string>; issues: IssueRow[]; pulls: PullRow[]; issueSeq: number; pullSeq: number; commentSeq: number; databaseId: number; }
interface PushCommand { oldOid: string; newOid: string; ref: string; }

interface Json { [key: string]: unknown; }

const OWNER = process.env.MAKEFUN_FORGE_LOGIN || 'adaiversen';
const AGENT = 'github-core-clone-forge/1.0';
const COMMIT_IDENTITY = 'Forge <forge@make.fun>';
const COMMIT_EPOCH = 1_700_000_000;
const REQUEST_ID = 'forge-0001';
const JSON_TYPE = 'application/json; charset=utf-8';
const repos = new Map<string, Repo>();

function repoKey(owner: string, name: string): string { return `${owner}/${name}`; }
function getRepo(owner: string, name: string): Repo | undefined { return repos.get(repoKey(owner, name)); }

function hashObject(type: ObjType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\u0000`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

function parseCommit(data: Buffer): { tree: string; parents: string[]; author: string; committer: string; message: string; extra: Array<[string, string]> } {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const headerText = text.slice(0, blank < 0 ? text.length : blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  const extra: Array<[string, string]> = [];
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
    else extra.push([key, value]);
  }
  return { tree, parents, author, committer, message, extra };
}

function buildCommit(tree: string, parents: readonly string[], message: string): Buffer {
  const lines = [`tree ${tree}`];
  for (const p of parents) lines.push(`parent ${p}`);
  lines.push(`author ${COMMIT_IDENTITY} ${COMMIT_EPOCH} +0000`, `committer ${COMMIT_IDENTITY} ${COMMIT_EPOCH} +0000`, '');
  return Buffer.from(`${lines.join('\n')}\n${message}`, 'utf8');
}

function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = data.indexOf(0x00, space + 1);
    if (nul + 21 > data.length) throw new Error('tree entry has a truncated object id');
    entries.push({ mode: data.subarray(offset, space).toString('ascii'), name: data.subarray(space + 1, nul).toString('utf8'), oid: data.subarray(nul + 1, nul + 21).toString('hex') });
    offset = nul + 21;
  }
  return entries;
}

function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

function buildTree(entries: ReadonlyArray<TreeEntry>): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\u0000`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

function parseTag(data: Buffer): { object: string; type: string; tag: string; tagger: string; message: string } {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const headers = new Map<string, string>();
  for (const line of text.slice(0, blank < 0 ? text.length : blank).split('\n')) {
    const space = line.indexOf(' ');
    if (space > 0) headers.set(line.slice(0, space), line.slice(space + 1));
  }
  return { object: headers.get('object') ?? '', type: headers.get('type') ?? '', tag: headers.get('tag') ?? '', tagger: headers.get('tagger') ?? '', message: blank < 0 ? '' : text.slice(blank + 2) };
}

function storeTree(repo: Repo, data: Buffer): string {
  const oid = hashObject('tree', data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type: 'tree', data });
  return oid;
}

function setTreeEntry(repo: Repo, treeOid: string | null, path: string, blobOid: string): string {
  const segments = path.split('/').filter((s) => s !== '');
  if (segments.length === 0) throw new Error(`a contents path is empty: ${path}`);
  const baseEntries = (): TreeEntry[] => {
    if (treeOid === null) return [];
    const obj = repo.objects.get(treeOid);
    return obj !== undefined && obj.type === 'tree' ? parseTree(obj.data) : [];
  };
  const childTreeOf = (entries: TreeEntry[], head: string): string | null => {
    const dir = entries.find((e) => e.name === head && e.mode === '40000');
    if (dir === undefined) return null;
    const obj = repo.objects.get(dir.oid);
    return obj !== undefined && obj.type === 'tree' ? parseTree(obj.data) : [];
  };
  const build = (entries: TreeEntry[], segs: readonly string[]): string => {
    const head = segs[0];
    const kept = entries.filter((e) => e.name !== head);
    if (segs.length === 1) {
      kept.push({ mode: '100644', name: head, oid: blobOid });
      return storeTree(repo, buildTree(kept));
    }
    const childOid = build(childTreeOf(entries, head) ?? [], segs.slice(1));
    kept.push({ mode: '40000', name: head, oid: childOid });
    return storeTree(repo, buildTree(kept));
  };
  return build(baseEntries(), segments);
}

function deleteTreeEntry(repo: Repo, treeOid: string, segments: readonly string[]): string {
  const head = segments[0];
  if (segments.length === 0) throw new Error('a contents path is empty');
  const baseEntries = parseTree(repo.objects.get(treeOid)!.data);
  const kept = baseEntries.filter((e) => e.name !== head);
  if (segments.length === 1) return storeTree(repo, buildTree(kept));
  const dir = baseEntries.find((e) => e.name === head && e.mode === '40000');
  if (dir === undefined) throw new Error(`no directory ${head}`);
  const childOid = deleteTreeEntry(repo, dir.oid, segments.slice(1));
  kept.push({ mode: '40000', name: head, oid: childOid });
  return storeTree(repo, buildTree(kept));
}

function treeMap(repo: Repo, treeOid: string): Map<string, BlobRef> {
  const map = new Map<string, BlobRef>();
  const walk = (oid: string, prefix: string): void => {
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'tree') return;
    for (const entry of parseTree(obj.data)) {
      if (entry.mode === '160000') continue;
      map.set(prefix + entry.name, { oid: entry.oid, mode: entry.mode });
      if (entry.mode === '40000') walk(entry.oid, `${prefix}${entry.name}/`);
    }
  };
  walk(treeOid, '');
  return map;
}

function diffPaths(repo: Repo, fromOid: string, toOid: string): Map<string, BlobRef> {
  const a = treeMap(repo, fromOid);
  const b = treeMap(repo, toOid);
  const out = new Map<string, BlobRef>();
  for (const [path, entry] of b) if (a.get(path)?.oid !== entry.oid) out.set(path, entry);
  for (const [path, entry] of a) if (!b.has(path)) out.set(path, entry);
  return out;
}

function treeEntryAt(repo: Repo, treeOid: string, segments: readonly string[]): { kind: 'file' | 'dir'; oid: string } | null {
  if (segments.length === 0) return null;
  const obj = repo.objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return null;
  const entry = parseTree(obj.data).find((e) => e.name === segments[0]);
  if (entry === undefined) return null;
  if (segments.length === 1) return { kind: entry.mode === '40000' ? 'dir' : 'file', oid: entry.oid };
  if (entry.mode !== '40000') return null;
  return treeEntryAt(repo, entry.oid, segments.slice(1));
}

function resolveRef(repo: Repo, ref: string): string | undefined {
  return repo.refs.get(ref) ?? repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(`refs/tags/${ref}`);
}

function reachableAll(repo: Repo, roots: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj === undefined) continue;
    seen.add(oid);
    if (obj.type === 'commit') { const c = parseCommit(obj.data); stack.push(c.tree, ...c.parents); }
    else if (obj.type === 'tag') stack.push(parseTag(obj.data).object);
    else if (obj.type === 'tree') { for (const e of parseTree(obj.data)) if (e.mode !== '160000') stack.push(e.oid); }
  }
  return seen;
}

function reachableCommits(repo: Repo, roots: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length) {
    const oid = stack.pop()!;
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit' || seen.has(oid)) continue;
    seen.add(oid);
    stack.push(...parseCommit(obj.data).parents);
  }
  return seen;
}

function isDescendant(repo: Repo, newOid: string, current: string): boolean {
  const stack: string[] = [newOid];
  const seen = new Set<string>();
  while (stack.length) {
    const oid = stack.pop()!;
    if (oid === current) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (obj === undefined) return false;
    if (obj.type === 'commit') stack.push(...parseCommit(obj.data).parents);
    else if (obj.type === 'tag') stack.push(parseTag(obj.data).object);
  }
  return false;
}

function pickCommonAncestor(repo: Repo, head: string, base: string): string | null {
  const baseSet = reachableCommits(repo, [base]);
  const queue: string[] = [head];
  const seen = new Set<string>();
  while (queue.length) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    if (baseSet.has(oid)) return oid;
    queue.push(...parseCommit(obj.data).parents);
  }
  return null;
}

function walkCommitToWindow(repo: Repo, oid: string, gen: number, depth: number | null, window: Set<string>): void {
  const obj = repo.objects.get(oid);
  if (!obj || obj.type !== 'commit' || window.has(oid)) return;
  window.add(oid);
  const c = parseCommit(obj.data);
  const addTree = (treeOid: string): void => {
    window.add(treeOid);
    const tree = repo.objects.get(treeOid);
    if (!tree || tree.type !== 'tree') return;
    for (const entry of parseTree(tree.data)) {
      if (entry.mode === '160000') continue;
      window.add(entry.oid);
      if (entry.mode === '40000') addTree(entry.oid);
    }
  };
  addTree(c.tree);
  if (depth !== null && gen + 1 >= depth) return;
  for (const parent of c.parents) walkCommitToWindow(repo, parent, gen + 1, depth, window);
}

function walkWantToWindow(repo: Repo, oid: string, depth: number | null, window: Set<string>): void {
  const obj = repo.objects.get(oid);
  if (!obj) return;
  if (obj.type === 'commit') { walkCommitToWindow(repo, oid, 0, depth, window); return; }
  if (obj.type === 'tag') {
    window.add(oid);
    const t = parseTag(obj.data);
    if (t.type === 'commit') walkCommitToWindow(repo, t.object, 0, depth, window);
    else walkWantToWindow(repo, t.object, depth, window);
    return;
  }
  if (obj.type === 'tree') {
    const entries: TreeEntry[] = parseTree(obj.data);
    window.add(oid);
    for (const entry of entries) { window.add(entry.oid); if (entry.mode === '40000') walkWantToWindow(repo, entry.oid, depth, window); }
    return;
  }
  window.add(oid);
}

function buildFetchResponse(repo: Repo, wants: readonly string[], haves: readonly string[], depth: number | null): Buffer {
  const window = new Set<string>();
  for (const want of wants) walkWantToWindow(repo, want, depth, window);
  const excluded = depth === null ? reachableAll(repo, haves) : new Set<string>();
  const packObjects = [...window].filter((oid) => !excluded.has(oid)).map((oid) => repo.objects.get(oid)!).filter((o) => o !== undefined);
  const shallowLines: string[] = [];
  for (const oid of window) {
    if (excluded.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) {
      if (!window.has(parent) && !excluded.has(parent)) { shallowLines.push(oid); break; }
    }
  }
  const out: Buffer[] = [];
  if (shallowLines.length > 0) {
    out.push(pktLine('shallow-info\n'));
    for (const oid of shallowLines) out.push(pktLine(`shallow ${oid}\n`));
    out.push(pktLine('0000'));
  }
  if (packObjects.length > 0) {
    const pack = writePack(packObjects);
    out.push(pktLine('packfile\n'));
    for (let off = 0; off < pack.length; off += 65515) {
      out.push(pktLine(Buffer.concat([Buffer.from([1]), pack.subarray(off, off + 65515)])));
    }
    out.push(pktLine('0000'));
  }
  return Buffer.concat(out);
}

function repoIdOf(repo: Repo): string { return `R_${hashObject('repo', Buffer.from(repoKey(repo.owner, repo.name)))}`; }

function repoDatabaseId(repo: Repo): number {
  if (repo.databaseId === 0) {
    const n = Number.parseInt(createHash('sha1').update(Buffer.from(`dbid:${repoKey(repo.owner, repo.name)}`)).digest('hex').slice(0, 6), 16);
    repo.databaseId = n > 0 ? n : 1;
  }
  return repo.databaseId;
}

function issueGlobalId(repo: Repo, number: number): string { return `I_${hashObject('issue', Buffer.from(`${repoKey(repo.owner, repo.name)}/issue:${number}`))}`; }

function pullGlobalId(repo: Repo, number: number): string { return `G_${hashObject('pull', Buffer.from(`${repoKey(repo.owner, repo.name)}/pull:${number}`))}`; }

function createRepoRow(owner: string, name: string, privateFlag: boolean, description: string): Repo | null {
  const key = repoKey(owner, name);
  if (repos.has(key)) return null;
  const repo: Repo = { owner, name, private: privateFlag, description, refs: new Map(), objects: new Map(), defaultBranch: 'main', labels: new Set(), issues: [], pulls: [], issueSeq: 0, pullSeq: 0, commentSeq: 0, databaseId: 0 };
  repos.set(key, repo);
  return repo;
}

function findIssue(repo: Repo, number: number): IssueRow | undefined { return repo.issues.find((issue) => issue.number === number); }
function findPull(repo: Repo, number: number): PullRow | undefined { return repo.pulls.find((pr) => pr.number === number); }

function createIssueRow(repo: Repo, body: Json): IssueRow {
  const labels = (Array.isArray(body.labels) ? body.labels : []).map((l) => String(l));
  for (const label of labels) {
    if (!repo.labels.has(label)) throw httpError(422, `Validation Failed: label ${JSON.stringify(label)} does not exist`);
  }
  repo.issueSeq += 1;
  const issue: IssueRow = { id: issueGlobalId(repo, repo.issueSeq), number: repo.issueSeq, title: String(body.title ?? ''), body: String(body.body ?? ''), state: 'open', labels, comments: [] };
  repo.issues.push(issue);
  return issue;
}

function createPullRow(repo: Repo, body: Json): PullRow {
  const head = String(body.head ?? '');
  const base = String(body.base ?? '');
  const headTip = repo.refs.get(`refs/heads/${head}`);
  const baseTip = repo.refs.get(`refs/heads/${base}`);
  if (headTip === undefined || baseTip === undefined) throw httpError(422, 'Validation Failed: head or base branch does not exist');
  repo.pullSeq += 1;
  const pr: PullRow = { id: pullGlobalId(repo, repo.pullSeq), number: repo.pullSeq, state: 'open', title: String(body.title ?? ''), body: String(body.body ?? ''), merged: false, mergedAt: '', mergeCommitSha: '', head: { ref: head, sha: headTip }, base: { ref: base, sha: baseTip } };
  repo.pulls.push(pr);
  return pr;
}

function serializeIssue(issue: IssueRow): Json {
  return { id: issue.id, number: issue.number, title: issue.title, body: issue.body, state: issue.state, labels: issue.labels.map((name) => ({ name })) };
}

function serializePull(pr: PullRow): Json {
  return { id: pr.id, number: pr.number, state: pr.state, merged: pr.merged, title: pr.title, body: pr.body, merged_at: pr.mergedAt, merge_commit_sha: pr.mergeCommitSha, head: { ref: pr.head.ref, sha: pr.head.sha }, base: { ref: pr.base.ref, sha: pr.base.sha } };
}

function serializeRepo(repo: Repo): Json {
  return { id: repoIdOf(repo), name: repo.name, private: repo.private, description: repo.description, default_branch: repo.defaultBranch };
}

function repoInfo(repo: Repo): Json {
  return {
    id: repoIdOf(repo),
    databaseId: repoDatabaseId(repo),
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    defaultBranchRef: { name: repo.defaultBranch },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    issue: null,
    issues: null,
    pullRequests: null,
    pullRequest: null,
  };
}

function mergePullRows(repo: Repo, pr: PullRow): void {
  const headTip = repo.refs.get(`refs/heads/${pr.head.ref}`);
  const baseTip = repo.refs.get(`refs/heads/${pr.base.ref}`);
  if (headTip === undefined || baseTip === undefined) throw new Error('pull request refs are missing');
  const mergeBase = pickCommonAncestor(repo, headTip, baseTip);
  if (mergeBase !== null) {
    const headChanges = diffPaths(repo, mergeBase, headTip);
    const baseChanges = diffPaths(repo, mergeBase, baseTip);
    for (const [path, entry] of headChanges) {
      const baseEntry = baseChanges.get(path);
      if (baseEntry !== undefined && baseEntry.oid !== entry.oid) throw new Error(`merge conflict on ${path}`);
    }
  }
  const mergeCommit = buildCommit(parseCommit(repo.objects.get(headTip)!.data).tree, [baseTip], `Merge pull request #${pr.number}`);
  const mergeOid = hashObject('commit', mergeCommit);
  repo.objects.set(mergeOid, { type: 'commit', data: mergeCommit });
  repo.refs.set(`refs/heads/${pr.base.ref}`, mergeOid);
  pr.state = 'closed';
  pr.merged = true;
  pr.mergedAt = '2026-11-20T00:00:00.000Z';
  pr.mergeCommitSha = mergeOid;
}

// ---------------------------------------------------------------- errors and plumbing

function httpError(status: number, message: string): Error {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), 'x-github-request-id': REQUEST_ID, ...headers });
  res.end(text);
}

function sendError(res: ServerResponse, err: unknown): void {
  const status = (err as { status?: number } | null)?.status;
  if (typeof status === 'number') { sendJson(res, status, { message: (err as Error).message || 'error' }); return; }
  sendJson(res, 500, { message: 'Internal server error' });
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk as Buffer));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseJsonBody(body: Buffer): Json {
  return JSON.parse(body.toString('utf8')) as Json;
}

function authOk(req: IncomingMessage): boolean {
  const auth = req.headers.authorization;
  return typeof auth === 'string' && auth.startsWith('Bearer ');
}

function pktLine(data: string | Buffer): Buffer {
  const body = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const header = Buffer.alloc(4);
  header.write((body.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, body]);
}

function parsePktLines(body: Buffer): Array<{ kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'response-end' }> {
  const out: Array<{ kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'response-end' }> = [];
  let pos = 0;
  while (pos + 4 <= body.length) {
    const header = body.subarray(pos, pos + 4).toString('ascii');
    if (!/^[0-9a-f]{4}$/.test(header)) break;
    const len = Number.parseInt(header, 16);
    if (len === 0) { out.push({ kind: 'flush' }); pos += 4; continue; }
    if (len === 1) { out.push({ kind: 'delim' }); pos += 4; continue; }
    if (len === 2) { out.push({ kind: 'response-end' }); pos += 4; continue; }
    if (len < 5 || pos + len > body.length) break;
    out.push({ kind: 'data', payload: body.subarray(pos + 4, pos + len) });
    pos += len;
  }
  return out;
}

// ---------------------------------------------------------------- pack files

function writePackObjectHeader(type: ObjType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

function writePack(objects: ReadonlyArray<Obj>): Buffer {
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  const parts: Buffer[] = [header];
  for (const object of objects) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function readPackObjectHeader(pack: Buffer, off: number): { typeCode: number; size: number; next: number } {
  const b0 = pack[off];
  const typeCode = (b0 >> 4) & 0x07;
  let size = b0 & 0x0f;
  let pos = off + 1;
  if (b0 & 0x80) {
    let shift = 4;
    for (;;) {
      const b = pack[pos++];
      size += (b & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
  }
  return { typeCode, size, next: pos };
}

function parsePackEntries(pack: Buffer): Obj[] {
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const entries: Obj[] = [];
  let off = 12;
  const bodyEnd = pack.length - 20;
  for (let i = 0; i < count; i += 1) {
    const header = readPackObjectHeader(pack, off);
    off = header.next;
    const inflated = inflateSync(pack.subarray(off), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    const data = inflated.buffer;
    if (data.length !== header.size) throw new Error(`pack entry declares ${header.size} bytes but inflated to ${data.length}`);
    entries.push({ type: CODE_TYPE[header.typeCode], data });
    off += inflated.engine.bytesWritten;
  }
  if (off !== bodyEnd) throw new Error('pack has stray bytes before its trailer');
  return entries;
}

// ---------------------------------------------------------------- REST routes

function handleRepoGet(res: ServerResponse, owner: string, name: string): void {
  const repo = getRepo(owner, name);
  if (!repo) return sendJson(res, 404, { message: 'Not Found' });
  sendJson(res, 200, serializeRepo(repo));
}

function handleRepoPatch(res: ServerResponse, owner: string, name: string, body: Json): void {
  const repo = getRepo(owner, name);
  if (!repo) return sendJson(res, 404, { message: 'Not Found' });
  if (body.description !== undefined) repo.description = String(body.description);
  sendJson(res, 200, { description: repo.description });
}

function handleRepoDelete(res: ServerResponse, owner: string, name: string): void {
  const repo = getRepo(owner, name);
  if (!repo) return sendJson(res, 404, { message: 'Not Found' });
  repos.delete(repoKey(owner, name));
  res.writeHead(204, { 'content-length': '0' });
  res.end();
}

function handleUserReposList(res: ServerResponse, req: IncomingMessage): void {
  const url = new URL(req.url ?? '/', 'http://forge');
  const perPage = Number(url.searchParams.get('per_page') ?? 30);
  const offset = Number(url.searchParams.get('offset') ?? 0);
  const all = [...repos.values()].filter((r) => r.owner === OWNER).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const slice = all.slice(offset, offset + perPage);
  const headers: Record<string, string> = {};
  if (offset + perPage < all.length) {
    headers.link = `<http://${req.headers.host}/api/v3/user/repos?per_page=${perPage}&offset=${offset + perPage}>; rel="next"`;
  }
  sendJson(res, 200, slice.map((r) => ({ name: r.name, private: r.private, default_branch: r.defaultBranch, description: r.description })), headers);
}

function handleUserReposCreate(res: ServerResponse, body: Json): void {
  const name = String(body.name ?? '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) {
    return sendJson(res, 422, { message: `Validation Failed: bad repository name ${JSON.stringify(name)}` });
  }
  const repo = createRepoRow(OWNER, name, body.private === true, String(body.description ?? ''));
  if (!repo) return sendJson(res, 422, { message: `Repository already exists: ${name}` });
  sendJson(res, 201, serializeRepo(repo));
}

function handleGetContents(res: ServerResponse, repo: Repo, filePath: string, ref?: string | null): void {
  const tip = ref !== undefined && ref !== null ? resolveRef(repo, ref) : repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (tip === undefined) return sendJson(res, 404, { message: 'Not Found' });
  const commit = repo.objects.get(tip);
  if (commit === undefined || commit.type !== 'commit') return sendJson(res, 404, { message: 'Not Found' });
  const found = treeEntryAt(repo, parseCommit(commit.data).tree, filePath.split('/').filter((s) => s !== ''));
  if (found === undefined) return sendJson(res, 404, { message: 'Not Found' });
  if (found.kind === 'file') {
    const blob = repo.objects.get(found.oid);
    if (!blob || blob.type !== 'blob') return sendJson(res, 404, { message: 'Not Found' });
    sendJson(res, 200, { type: 'file', encoding: 'base64', content: blob.data.toString('base64'), sha: found.oid, size: blob.data.length });
    return;
  }
  const out: Json[] = [];
  const walk = (treeOid: string, prefix: string): void => {
    const obj = repo.objects.get(treeOid);
    if (!obj || obj.type !== 'tree') return;
    for (const entry of parseTree(obj.data)) {
      if (entry.mode === '160000') continue;
      out.push({ type: entry.mode === '40000' ? 'dir' : 'file', name: entry.name, path: `${prefix}${entry.name}`, sha: entry.oid });
      if (entry.mode === '40000') walk(entry.oid, `${prefix}${entry.name}/`);
    }
  };
  walk(found.oid, `${filePath.replace(/\/+$/, '')}/`);
  sendJson(res, 200, out);
}

function handlePutContents(res: ServerResponse, repo: Repo, filePath: string, body: Json, branch?: string): void {
  const content = Buffer.from(String(body.content ?? ''), 'base64');
  const message = String(body.message ?? '');
  const branchRef = branch !== undefined ? `refs/heads/${branch}` : `refs/heads/${repo.defaultBranch}`;
  const curTip = repo.refs.get(branchRef) ?? ZERO_OID;
  const commitTip = curTip !== ZERO_OID ? repo.objects.get(curTip) : undefined;
  const treeOid = commitTip !== undefined && commitTip.type === 'commit' ? parseCommit(commitTip.data).tree : null;
  const currentBlob = treeOid !== null ? treeMap(repo, treeOid).get(filePath)?.oid ?? null : null;
  const sha = body.sha;
  if (sha !== undefined && sha !== null && sha !== '') {
    if (currentBlob === null || String(sha) !== currentBlob) return sendJson(res, 409, { message: 'Validation Failed: sha does not match the current file' });
  }
  const blobOid = hashObject('blob', content);
  repo.objects.set(blobOid, { type: 'blob', data: content });
  const newTree = setTreeEntry(repo, treeOid, filePath, blobOid);
  const commitData = buildCommit(newTree, curTip !== ZERO_OID ? [curTip] : [], message);
  const commitOid = hashObject('commit', commitData);
  repo.objects.set(commitOid, { type: 'commit', data: commitData });
  repo.refs.set(branchRef, commitOid);
  sendJson(res, currentBlob === null ? 201 : 200, { content: { sha: blobOid, encoding: 'base64' }, commit: { sha: commitOid } });
}

function handleDeleteContents(res: ServerResponse, repo: Repo, filePath: string, body: Json): void {
  const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const commitTip = tip !== undefined ? repo.objects.get(tip) : undefined;
  if (commitTip === undefined || commitTip.type !== 'commit') return sendJson(res, 404, { message: 'Not Found' });
  const segments = filePath.split('/').filter((s) => s !== '');
  if (treeEntryAt(repo, parseCommit(commitTip.data).tree, segments) === null) return sendJson(res, 404, { message: 'Not Found' });
  const newTree = deleteTreeEntry(repo, parseCommit(commitTip.data).tree, segments);
  const commitData = buildCommit(newTree, tip !== undefined ? [tip] : [], String(body.message ?? ''));
  const commitOid = hashObject('commit', commitData);
  repo.objects.set(commitOid, { type: 'commit', data: commitData });
  repo.refs.set(`refs/heads/${repo.defaultBranch}`, commitOid);
  sendJson(res, 200, { commit: { sha: commitOid } });
}

async function handleApi(res: ServerResponse, req: IncomingMessage, rest: string, method: string, body: Buffer, query: URLSearchParams): Promise<void> {
  if (rest === '' || rest === '/') {
    if (method === 'GET') return sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return sendJson(res, 405, { message: 'Method Not Allowed' });
  }
  if (rest === '/meta') {
    if (method !== 'GET') return sendJson(res, 405, { message: 'Method Not Allowed' });
    sendJson(res, 200, { installed_version: 'github-core-clone-forge/1.0' });
    return;
  }
  if (rest === '/user') {
    if (method !== 'GET') return sendJson(res, 405, { message: 'Method Not Allowed' });
    sendJson(res, 200, { login: OWNER, id: 1, name: OWNER });
    return;
  }
  if (rest === '/user/repos') {
    if (method === 'GET') return handleUserReposList(res, req);
    if (method === 'POST') return handleUserReposCreate(res, parseJsonBody(body));
    return sendJson(res, 405, { message: 'Method Not Allowed' });
  }
  const repoRoot = rest.match(/^\/repos\/([^/]+)\/([^/]+)$/);
  if (repoRoot) {
    const owner = decodeURIComponent(repoRoot[1]);
    const name = decodeURIComponent(repoRoot[2]);
    if (method === 'GET') return handleRepoGet(res, owner, name);
    if (method === 'PATCH') return handleRepoPatch(res, owner, name, parseJsonBody(body));
    if (method === 'DELETE') return handleRepoDelete(res, owner, name);
    return sendJson(res, 405, { message: 'Method Not Allowed' });
  }
  const branches = rest.match(/^\/repos\/([^/]+)\/([^/]+)\/branches$/);
  if (branches) {
    if (method !== 'GET') return sendJson(res, 405, { message: 'Method Not Allowed' });
    const repo = getRepo(decodeURIComponent(branches[1]), decodeURIComponent(branches[2]));
    if (!repo) return sendJson(res, 404, { message: 'Not Found' });
    sendJson(res, 200, [...repo.refs.entries()].filter(([ref]) => ref.startsWith('refs/heads/')).map(([ref, oid]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha: oid } })));
    return;
  }
  const commits = rest.match(/^\/repos\/([^/]+)\/([^/]+)\/commits(?:\/([^/]+))?$/);
  if (commits) {
    if (method !== 'GET') return sendJson(res, 405, { message: 'Method Not Allowed' });
    const repo = getRepo(decodeURIComponent(commits[1]), decodeURIComponent(commits[2]));
    if (!repo) return sendJson(res, 404, { message: 'Not Found' });
    const tip = commits[3] !== undefined ? resolveRef(repo, commits[3]) : repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    const out: Json[] = [];
    if (tip !== undefined) {
      const seen = new Set<string>();
      const stack = [tip];
      while (stack.length) {
        const oid = stack.pop()!;
        if (seen.has(oid)) continue;
        seen.add(oid);
        const obj = repo.objects.get(oid);
        if (!obj || obj.type !== 'commit') continue;
        const c = parseCommit(obj.data);
        out.push({ sha: oid, commit: { message: c.message } });
        for (const p of c.parents) stack.push(p);
      }
    }
    sendJson(res, 200, out);
    return;
  }
  const gitRefs = rest.match(/^\/repos\/([^/]+)\/([^/]+)\/git\/refs$/);
  if (gitRefs) {
    if (method !== 'GET') return sendJson(res, 405, { message: 'Method Not Allowed' });
    const repo = getRepo(decodeURIComponent(gitRefs[1]), decodeURIComponent(gitRefs[2]));
    if (!repo) return sendJson(res, 404, { message: 'Not Found' });
    sendJson(res, 200, [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([ref, oid]) => ({ ref, object: { sha: oid } })));
    return;
  }
  const ghRefs = rest.match(/^\/repos\/([^/]+)\/([^/]+)\/branches\/([^/]+)$/);
  if (ghRefs) {
    if (method !== 'GET') return sendJson(res, 405, { message: 'Method Not Allowed' });
    const repo = getRepo(decodeURIComponent(ghRefs[1]), decodeURIComponent(ghRefs[2]));
    const tip = repo ? repo.refs.get(`refs/heads/${decodeURIComponent(ghRefs[3])}`) : undefined;
    if (repo === undefined || tip === undefined) return sendJson(res, 404, { message: 'Not Found' });
    sendJson(res, 200, { name: decodeURIComponent(ghRefs[3]), commit: { sha: tip } });
    return;
  }
  const refCreate = rest.match(/^\/repos\/([^/]+)\/([^/]+)\/git\/refs$/);
  if (refCreate) {
    if (method !== 'POST') return sendJson(res, 405, { message: 'Method Not Allowed' });
    const repo = getRepo(decodeURIComponent(refCreate[1]), decodeURIComponent(refCreate[2]));
    if (!repo) return sendJson(res, 404, { message: 'Not Found' });
    const input = parseJsonBody(body);
    const ref = String(input.ref ?? '');
    const sha = String(input.sha ?? '');
    if (!ref.startsWith('refs/heads/') && !ref.startsWith('refs/tags/')) {
      return sendJson(res, 422, { message: 'Validation Failed: a ref name must start with refs/' });
    }
    if (!HEX40.test(sha)) return sendJson(res, 422, { message: 'Validation Failed: a ref must name a full commit sha' });
    if (repo.refs.has(ref)) return sendJson(res, 422, { message: `Reference ${ref} already exists` });
    repo.refs.set(ref, sha);
    sendJson(res, 201, { ref, object: { sha } });
    return;
  }
  const issuesRoute = rest.match(/^\/repos\/([^/]+)\/([^/]+)\/issues$/);
  if (issuesRoute) {
    const repo = getRepo(decodeURIComponent(issuesRoute[1]), decodeURIComponent(issuesRoute[2]));
    if (!repo) return sendJson(res, 404, { message: 'Not Found' });
    if (method === 'POST') {
      try {
        sendJson(res, 201, createIssueRow(repo, parseJsonBody(body)));
      } catch (err) {
        sendError(res, err);
      }
      return;
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const direction = query.get('direction') === 'desc' ? -1 : 1;
      const issues = repo.issues.filter((issue) => state === 'all' || issue.state === state).sort((a, b) => direction * (a.number - b.number));
      sendJson(res, 200, issues.map(serializeIssue));
      return;
    }
    return sendJson(res, 405, { message: 'Method Not Allowed' });
  }
  const issueRoute = rest.match(/^\/repos\/([^/]+)\/([^/]+)\/issues\/([0-9]+)$/);
  if (issueRoute) {
    const repo = getRepo(decodeURIComponent(issueRoute[1]), decodeURIComponent(issueRoute[2]));
    const issue = repo ? findIssue(repo, Number(issueRoute[3])) : undefined;
    if (method === 'GET') {
      if (issue === undefined) return sendJson(res, 404, { message: 'Not Found' });
      sendJson(res, 200, serializeIssue(issue));
      return;
    }
    if (method === 'PATCH') {
      if (issue === undefined) return sendJson(res, 404, { message: 'Not Found' });
      const state = String(parseJsonBody(body).state ?? '');
      if (state !== 'open' && state !== 'closed') return sendJson(res, 422, { message: 'Validation Failed: state must be open or closed' });
      issue.state = state;
      sendJson(res, 200, { number: issue.number, state: issue.state });
      return;
    }
    return sendJson(res, 405, { message: 'Method Not Allowed' });
  }
  const issueComments = rest.match(/^\/repos\/([^/]+)\/([^/]+)\/issues\/([0-9]+)\/comments$/);
  if (issueComments) {
    const repo = getRepo(decodeURIComponent(issueComments[1]), decodeURIComponent(issueComments[2]));
    const issue = repo ? findIssue(repo, Number(issueComments[3])) : undefined;
    if (method === 'POST') {
      if (issue === undefined || repo === undefined) return sendJson(res, 404, { message: 'Not Found' });
      repo.commentSeq += 1;
      const comment = { id: repo.commentSeq, body: String(parseJsonBody(body).body ?? '') };
      issue.comments.push(comment);
      sendJson(res, 201, { id: comment.id, body: comment.body });
      return;
    }
    if (method === 'GET') {
      if (issue === undefined) return sendJson(res, 404, { message: 'Not Found' });
      sendJson(res, 200, issue.comments.map((c) => ({ id: c.id, body: c.body })));
      return;
    }
    return sendJson(res, 405, { message: 'Method Not Allowed' });
  }
  const labels = rest.match(/^\/repos\/([^/]+)\/([^/]+)\/labels$/);
  if (labels) {
    if (method !== 'POST') return sendJson(res, 405, { message: 'Method Not Allowed' });
    const repo = getRepo(decodeURIComponent(labels[1]), decodeURIComponent(labels[2]));
    if (!repo) return sendJson(res, 404, { message: 'Not Found' });
    const input = parseJsonBody(body);
    repo.labels.add(String(input.name ?? ''));
    sendJson(res, 201, { name: String(input.name ?? ''), color: String(input.color ?? 'ededed') });
    return;
  }
  const pullsRoute = rest.match(/^\/repos\/([^/]+)\/([^/]+)\/pulls$/);
  if (pullsRoute) {
    const repo = getRepo(decodeURIComponent(pullsRoute[1]), decodeURIComponent(pullsRoute[2]));
    if (!repo) return sendJson(res, 404, { message: 'Not Found' });
    if (method === 'POST') {
      try {
        sendJson(res, 201, createPullRow(repo, parseJsonBody(body)));
      } catch (err) {
        sendError(res, err);
      }
      return;
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      sendJson(res, 200, repo.pulls.filter((pr) => (state === 'all' ? true : pr.state === state)).map(serializePull));
      return;
    }
    return sendJson(res, 405, { message: 'Method Not Allowed' });
  }
  const pullRoute = rest.match(/^\/repos\/([^/]+)\/([^/]+)\/pulls\/([0-9]+)$/);
  if (pullRoute) {
    if (method !== 'GET') return sendJson(res, 405, { message: 'Method Not Allowed' });
    const repo = getRepo(decodeURIComponent(pullRoute[1]), decodeURIComponent(pullRoute[2]));
    const pr = repo ? findPull(repo, Number(pullRoute[3])) : undefined;
    if (pr === undefined) return sendJson(res, 404, { message: 'Not Found' });
    sendJson(res, 200, serializePull(pr));
    return;
  }
  const pullMerge = rest.match(/^\/repos\/([^/]+)\/([^/]+)\/pulls\/([0-9]+)\/merge$/);
  if (pullMerge) {
    if (method !== 'PUT') return sendJson(res, 405, { message: 'Method Not Allowed' });
    const repo = getRepo(decodeURIComponent(pullMerge[1]), decodeURIComponent(pullMerge[2]));
    const pr = repo ? findPull(repo, Number(pullMerge[3])) : undefined;
    if (pr === undefined || repo === undefined) return sendJson(res, 404, { message: 'Not Found' });
    if (pr.state !== 'open') return sendJson(res, 405, { message: 'Pull request is not open' });
    try {
      mergePullRows(repo, pr);
    } catch (err) {
      sendError(res, err);
      return;
    }
    sendJson(res, 200, { merged: true, sha: pr.mergeCommitSha, message: `Merge pull request #${pr.number}` });
    return;
  }
  const pullFiles = rest.match(/^\/repos\/([^/]+)\/([^/]+)\/pulls\/([0-9]+)\/files$/);
  if (pullFiles) {
    if (method !== 'GET') return sendJson(res, 405, { message: 'Method Not Allowed' });
    const repo = getRepo(decodeURIComponent(pullFiles[1]), decodeURIComponent(pullFiles[2]));
    const pr = repo ? findPull(repo, Number(pullFiles[3])) : undefined;
    if (pr === undefined || repo === undefined) return sendJson(res, 404, { message: 'Not Found' });
    const headTip = repo.refs.get(`refs/heads/${pr.head.ref}`);
    const baseTip = repo.refs.get(`refs/heads/${pr.base.ref}`);
    if (headTip === undefined || baseTip === undefined) return sendJson(res, 404, { message: 'Not Found' });
    const headMap = treeMap(repo, parseCommit(repo.objects.get(headTip)!.data).tree);
    const baseMap = treeMap(repo, parseCommit(repo.objects.get(baseTip)!.data).tree);
    const blobSize = (oid: string): number => repo.objects.get(oid)?.data.length ?? 0;
    const files: Json[] = [];
    for (const [path, entry] of headMap) {
      const old = baseMap.get(path);
      if (old === undefined) files.push({ filename: path, status: 'added', additions: blobSize(entry.oid), deletions: 0, changes: blobSize(entry.oid) });
      else if (old.oid !== entry.oid) files.push({ filename: path, status: 'modified', additions: Math.max(0, blobSize(entry.oid) - blobSize(old.oid)), deletions: Math.max(0, blobSize(old.oid) - blobSize(entry.oid)), changes: Math.abs(blobSize(entry.oid) - blobSize(old.oid)) });
    }
    for (const [path, entry] of baseMap) if (!headMap.has(path)) files.push({ filename: path, status: 'removed', additions: 0, deletions: blobSize(entry.oid), changes: blobSize(entry.oid) });
    sendJson(res, 200, files);
    return;
  }
  const contents = rest.match(/^\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/);
  if (contents) {
    const owner = decodeURIComponent(contents[1]);
    const name = decodeURIComponent(contents[2]);
    const filePath = contents[3].split('/').map(decodeURIComponent).join('/');
    const repo = getRepo(owner, name);
    if (!repo) return sendJson(res, 404, { message: 'Not Found' });
    if (method === 'PUT') return handlePutContents(res, repo, filePath, parseJsonBody(body), query.get('branch'));
    if (method === 'GET') return handleGetContents(res, repo, filePath, query.get('ref'));
    if (method === 'DELETE') return handleDeleteContents(res, repo, filePath, parseJsonBody(body));
    return sendJson(res, 405, { message: 'Method Not Allowed' });
  }
  return sendJson(res, 404, { message: 'Not Found' });
}

// ---------------------------------------------------------------- git smart HTTP

function listRefs(repo: Repo): Array<{ oid: string; name: string; symrefTarget?: string; peeled?: string }> {
  const out: Array<{ oid: string; name: string; symrefTarget?: string; peeled?: string }> = [];
  const mainOid = repo.refs.get('refs/heads/main');
  if (mainOid !== undefined) out.push({ oid: mainOid, name: 'HEAD', symrefTarget: 'refs/heads/main' });
  for (const name of [...repo.refs.keys()].sort()) {
    const oid = repo.refs.get(name)!;
    let peeled: string | undefined;
    if (name.startsWith('refs/tags/')) {
      const obj = repo.objects.get(oid);
      if (obj !== undefined && obj.type === 'tag') peeled = parseTag(obj.data).object;
    }
    out.push({ oid, name, peeled });
  }
  return out;
}

function lsRefsBody(repo: Repo, opts: { peel?: boolean; symrefs?: boolean; prefixes?: readonly string[] }): Buffer {
  const lines: Buffer[] = [];
  for (const ref of listRefs(repo)) {
    const keep = opts.prefixes === undefined || opts.prefixes.length === 0 ? true : opts.prefixes.some((p) => ref.name.startsWith(p));
    if (!keep) continue;
    const tokens: string[] = [];
    if (opts.symrefs === true && ref.symrefTarget !== undefined) tokens.push(`symref-target:${ref.symrefTarget}`);
    if (opts.peel === true && ref.peeled !== undefined) tokens.push(`peeled:${ref.peeled}`);
    lines.push(pktLine(tokens.length > 0 ? `${ref.oid} ${ref.name} ${tokens.join(' ')}\n` : `${ref.oid} ${ref.name}\n`));
  }
  return Buffer.concat([...lines, pktLine('0000')]);
}

function handleLsRefs(repo: Repo, body: Buffer): Buffer {
  const opts: { peel: boolean; symrefs: boolean; prefixes: string[] } = { peel: false, symrefs: false, prefixes: [] };
  for (const packet of parsePktLines(body)) {
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8').replace(/\n$/, '');
    if (text === 'peel') opts.peel = true;
    else if (text === 'symrefs') opts.symrefs = true;
    else if (text.startsWith('ref-prefix ')) opts.prefixes.push(text.slice('ref-prefix '.length));
  }
  return lsRefsBody(repo, opts);
}

function handleFetch(repo: Repo, body: Buffer): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  let depth: number | null = null;
  for (const packet of parsePktLines(body)) {
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8').replace(/\n$/, '');
    if (text.startsWith('want ')) wants.push(text.slice(5));
    else if (text.startsWith('have ')) haves.push(text.slice(5));
    else if (text.startsWith('deepen ')) depth = Number(text.slice(7));
  }
  return buildFetchResponse(repo, wants, haves, depth);
}

function parsePushBody(body: Buffer): { commands: PushCommand[]; pack: Buffer } {
  const commands: PushCommand[] = [];
  let pos = 0;
  while (pos + 4 <= body.length) {
    const header = body.subarray(pos, pos + 4).toString('ascii');
    if (!/^[0-9a-f]{4}$/.test(header)) break;
    const len = Number.parseInt(header, 16);
    if (len === 0) { pos += 4; break; }
    if (len < 5) { pos += 4; continue; }
    if (pos + len > body.length) break;
    const line = body.subarray(pos + 4, pos + len).toString('utf8').split('\u0000')[0];
    const parts = line.split(' ');
    if (parts.length >= 3) commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts.slice(2).join(' ') });
    pos += len;
  }
  return { commands, pack: body.subarray(pos) };
}

function handleReceivePack(repo: Repo, body: Buffer): Buffer {
  const { commands, pack } = parsePushBody(body);
  if (pack.length > 0) {
    for (const entry of parsePackEntries(pack)) {
      const oid = hashObject(entry.type, entry.data);
      if (!repo.objects.has(oid)) repo.objects.set(oid, entry);
    }
  }
  const lines = ['unpack ok'];
  for (const cmd of commands) {
    const current = repo.refs.get(cmd.ref) ?? ZERO_OID;
    if (cmd.oldOid !== current) {
      lines.push(`ng ${cmd.ref} stale`);
      continue;
    }
    if (cmd.newOid !== ZERO_OID && current !== ZERO_OID && !isDescendant(repo, cmd.newOid, current)) {
      lines.push(`ng ${cmd.ref} non-fast-forward`);
      continue;
    }
    if (cmd.newOid === ZERO_OID && current !== ZERO_OID) {
      repo.refs.delete(cmd.ref);
      lines.push(`ok ${cmd.ref}`);
      continue;
    }
    repo.refs.set(cmd.ref, cmd.newOid);
    lines.push(`ok ${cmd.ref}`);
  }
  const text = lines.map((line) => `${line}\n`).join('');
  return Buffer.concat([pktLine(Buffer.concat([Buffer.from([1]), text])), pktLine('0000')]);
}

function v0Advertisement(res: ServerResponse, service: 'git-upload-pack' | 'git-receive-pack', repo: Repo): void {
  const refs = listRefs(repo);
  const head = refs.find((r) => r.symrefTarget !== undefined);
  const caps: string[] = [];
  if (service === 'git-receive-pack') caps.push('report-status', 'side-band-64k', 'delete-refs', 'ofs-delta');
  if (head !== undefined) caps.push(`symref=HEAD:${head.symrefTarget}`);
  const capText = caps.length > 0 ? `\u0000${caps.join(' ')}` : '';
  const body = Buffer.concat([
    pktLine(`# service=${service}\n`),
    pktLine('0000'),
    ...refs.map((ref, index) => pktLine(`${ref.oid} ${ref.name}${index === 0 ? capText : ''}\n`)),
    pktLine('0000'),
  ]);
  res.writeHead(200, { 'content-type': `application/x-${service}-advertisement`, 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function v2Advertisement(res: ServerResponse, repo: Repo): void {
  const out = [pktLine('version 2\n'), pktLine('ls-refs\n'), pktLine('fetch=shallow\n'), pktLine(`agent=${AGENT}\n`), pktLine('0000')];
  res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-advertisement', 'content-length': Buffer.byteLength(Buffer.concat(out)) });
  res.end(Buffer.concat(out));
}

async function handleGitHttp(req: IncomingMessage, res: ServerResponse, pathname: string, method: string, body: Buffer, query: URLSearchParams): Promise<void> {
  const m = pathname.match(/^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/);
  if (!m) { sendJson(res, 404, { message: 'Not Found' }); return; }
  const repo = getRepo(decodeURIComponent(m[1]), decodeURIComponent(m[2]));
  if (repo === undefined) { sendJson(res, 404, { message: 'Not Found' }); return; }
  if (m[3] === 'info/refs') {
    if (method !== 'GET') return sendJson(res, 405, { message: 'Method Not Allowed' });
    const service = query.get('service') === 'git-receive-pack' ? 'git-receive-pack' : 'git-upload-pack';
    const wantsV2 = service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '').includes('version=2');
    if (wantsV2) return v2Advertisement(res, repo);
    return v0Advertisement(res, service, repo);
  }
  if (m[3] === 'git-upload-pack') {
    if (method !== 'POST') return sendJson(res, 405, { message: 'Method Not Allowed' });
    const first = parsePktLines(body).find((p): p is { kind: 'data'; payload: Buffer } => p.kind === 'data');
    const command = first === undefined ? '' : first.payload.toString('utf8').replace(/\n$/, '');
    const response = command === 'command=ls-refs' ? handleLsRefs(repo, body) : handleFetch(repo, body);
    res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'content-length': Buffer.byteLength(response) });
    res.end(response);
    return;
  }
  if (m[3] === 'git-receive-pack') {
    if (method !== 'POST') return sendJson(res, 405, { message: 'Method Not Allowed' });
    const response = handleReceivePack(repo, body);
    res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-result', 'content-length': Buffer.byteLength(response) });
    res.end(response);
    return;
  }
  sendJson(res, 404, { message: 'Not Found' });
}

// ---------------------------------------------------------------- GraphQL

function findRepoByOwnerName(owner: string | undefined, name: string | undefined): Repo | undefined {
  return owner !== undefined && name !== undefined ? getRepo(String(owner), String(name)) : undefined;
}

function findRepoByGlobalId(id: string): Repo | undefined {
  for (const repo of repos.values()) if (repoIdOf(repo) === id) return repo;
  return undefined;
}

function findIssueByGlobalId(id: string): { repo: Repo; issue: IssueRow } | undefined {
  for (const repo of repos.values()) for (const issue of repo.issues) if (issue.id === id) return { repo, issue };
  return undefined;
}

function findPullByGlobalId(id: string): { repo: Repo; pr: PullRow } | undefined {
  for (const repo of repos.values()) for (const pr of repo.pulls) if (pr.id === id) return { repo, pr };
  return undefined;
}

const ISSUE_FIELD_NAMES = ['id', 'number', 'title', 'state', 'body', 'labels', 'comments'];
const PULL_FIELD_NAMES = ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'];
const REPOSITORY_FIELD_NAMES = ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'];
const SEARCH_ENUMS = ['ISSUE', 'PULL_REQUEST', 'REPO', 'DISCUSSION', 'COMMIT', 'PULL_REQUEST_REVIEW', 'ISSUE_COMMENT'];

function pullFilePaths(repo: Repo, pr: PullRow): Array<{ path: string }> {
  const headTip = repo.refs.get(`refs/heads/${pr.head.ref}`);
  const baseTip = repo.refs.get(`refs/heads/${pr.base.ref}`);
  if (headTip === undefined || baseTip === undefined) return [];
  const headMap = treeMap(repo, parseCommit(repo.objects.get(headTip)!.data).tree);
  const baseMap = treeMap(repo, parseCommit(repo.objects.get(baseTip)!.data).tree);
  const out: Array<{ path: string }> = [];
  for (const [path, entry] of headMap) if (!baseMap.has(path) || baseMap.get(path)?.oid !== entry.oid) out.push({ path });
  return out;
}

function gqlGraphQL(doc: string, v: Json): { data: Json | null; errors: Json[] } {
  const m = /(?:query|mutation)\s+([A-Za-z0-9_]+)/.exec(doc);
  const name = m === null ? '' : m[1];
  try {
    switch (name) {
      case 'ViewerLogin':
        return { data: { viewer: { login: OWNER } }, errors: [] };
      case 'RepositoryFields': {
        const repo = findRepoByOwnerName(v.owner, v.name);
        return { data: { repository: repo === undefined ? null : repoInfo(repo) }, errors: [] };
      }
      case 'Issue_fields':
        return { data: { Issue: { fields: ISSUE_FIELD_NAMES.map((n) => ({ name: n })) } }, errors: [] };
      case 'PullRequestAndRepositoryFields':
        return { data: { PullRequest: { fields: PULL_FIELD_NAMES.map((n) => ({ name: n })) }, Repository: { fields: REPOSITORY_FIELD_NAMES.map((n) => ({ name: n })) } }, errors: [] };
      case 'SearchType_enumValues':
        return { data: { SearchType: { enumValues: SEARCH_ENUMS.map((n) => ({ name: n })) } }, errors: [] };
      case 'OpenIssues': {
        const repo = findRepoByOwnerName(v.owner, v.name);
        if (repo === undefined) return { data: { repository: { issues: { nodes: [] } } }, errors: [] };
        const nodes = repo.issues.filter((i) => i.state === 'open').sort((a, b) => b.number - a.number).slice(0, 10).map((i) => ({ number: i.number, title: i.title, state: i.state.toUpperCase(), id: i.id }));
        return { data: { repository: { issues: { nodes } } }, errors: [] };
      }
      case 'IssueByNumber': {
        const repo = findRepoByOwnerName(v.owner, v.name);
        const issue = repo === undefined ? undefined : findIssue(repo, Number(v.number));
        return { data: { repository: { issue: issue === undefined ? null : { number: issue.number, title: issue.title, state: issue.state.toUpperCase(), id: issue.id, body: issue.body } } }, errors: [] };
      }
      case 'CreateIssue': {
        const repo = findRepoByGlobalId(String((v.input as Json | undefined)?.repositoryId ?? ''));
        if (repo === undefined) return { data: null, errors: [{ message: 'createIssue: repository not found' }] };
        const input = (v.input ?? {}) as Json;
        const issue = createIssueRow(repo, { title: input.title, body: input.body });
        return { data: { createIssue: { issue: { number: issue.number, id: issue.id } } }, errors: [] };
      }
      case 'CloseIssue': {
        const issue = findIssueByGlobalId(String(v.issueId ?? ''));
        if (issue === undefined) return { data: null, errors: [{ message: 'closeIssue: issue not found' }] };
        issue.state = 'closed';
        return { data: { closeIssue: { issue: { number: issue.number, id: issue.id, state: 'CLOSED' } } }, errors: [] };
      }
      case 'PullRequests': {
        const repo = findRepoByOwnerName(v.owner, v.name);
        const nodes = repo === undefined ? [] : repo.pulls.slice(0, 5).map((pr) => ({ number: pr.number, headRefName: pr.head.ref, baseRefName: pr.base.ref, mergeable: 'MERGEABLE', state: pr.state.toUpperCase() }));
        return { data: { repository: { pullRequests: { nodes } } }, errors: [] };
      }
      case 'PullRequestFiles': {
        const repo = findRepoByOwnerName(v.owner, v.name);
        const pr = repo === undefined ? undefined : findPull(repo, Number(v.number));
        return { data: { repository: { pullRequest: pr === undefined ? null : { number: pr.number, files: { nodes: pullFilePaths(repo!, pr) } } } }, errors: [] };
      }
      case 'PullRequestId': {
        const repo = findRepoByOwnerName(v.owner, v.name);
        const pr = repo === undefined ? undefined : findPull(repo, Number(v.number));
        return { data: { repository: { pullRequest: pr === undefined ? null : { id: pr.id, number: pr.number } } }, errors: [] };
      }
      case 'CreatePullRequest': {
        const repo = findRepoByGlobalId(String((v.input as Json | undefined)?.repositoryId ?? ''));
        if (repo === undefined) return { data: null, errors: [{ message: 'createPullRequest: repository not found' }] };
        const input = (v.input ?? {}) as Json;
        const pr = createPullRow(repo, { title: input.title, body: '', head: String(input.headRefName ?? ''), base: String(input.baseRefName ?? '') });
        return { data: { createPullRequest: { pullRequest: { number: pr.number, id: pr.id, state: 'OPEN', headRefName: pr.head.ref, baseRefName: pr.base.ref } } }, errors: [] };
      }
      case 'MergePullRequest': {
        const found = findPullByGlobalId(String(v.pullRequestId ?? ''));
        if (found === undefined) return { data: null, errors: [{ message: 'mergePullRequest: pull request not found' }] };
        mergePullRows(found.repo, found.pr);
        return { data: { mergePullRequest: { pullRequest: { number: found.pr.number, merged: found.pr.merged, state: found.pr.state.toUpperCase() } } }, errors: [] };
      }
      case 'AddComment': {
        const found = findIssueByGlobalId(String((v.input as Json | undefined)?.subjectId ?? ''));
        if (found === undefined) return { data: null, errors: [{ message: 'addComment: subject not found' }] };
        const { repo, issue } = found;
        const bodyText = String((v.input as Json).body ?? '');
        repo.commentSeq += 1;
        const comment = { id: `C_${repo.commentSeq}`, body: bodyText };
        issue.comments.push(comment);
        return { data: { addComment: { commentEdge: { node: { id: comment.id, body: comment.body } } } }, errors: [] };
      }
      case 'NodeRepository': {
        const repo = findRepoByGlobalId(String(v.id ?? ''));
        return { data: { node: repo === undefined ? null : { id: repoIdOf(repo), name: repo.name, nameWithOwner: `${repo.owner}/${repo.name}` } }, errors: repo === undefined ? [{ message: 'node: repository not found' }] : [] };
      }
      case 'IssuesPage': {
        const repo = findRepoByOwnerName(v.owner, v.name);
        if (repo === undefined) return { data: { repository: { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: '' } } } }, errors: [] };
        const sorted = repo.issues.slice().sort((a, b) => b.number - a.number);
        const after = v.after === undefined || v.after === null ? null : String(v.after);
        let start = 0;
        if (after !== null) {
          const idx = sorted.findIndex((i) => String(i.number) < after);
          start = idx === -1 ? sorted.length : idx;
        }
        const first = Number(v.first ?? 5);
        const nodes = sorted.slice(start, start + first).map((i) => ({ number: i.number }));
        const last = nodes[nodes.length - 1];
        return { data: { repository: { issues: { nodes, pageInfo: { hasNextPage: start + first < sorted.length, endCursor: last === undefined ? '' : String(last.number) } } } }, errors: [] };
      }
      case 'ViewerInvalidField':
        return { data: null, errors: [{ message: 'Cannot query field "noSuchFieldOnViewer" on type "Viewer". [noSuchFieldOnViewer]' }] };
      default:
        return { data: null, errors: [{ message: `Cannot query field "${name || 'unknown'}": unknown operation` }] };
    }
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
}

async function handleGraphql(req: IncomingMessage, res: ServerResponse, body: Buffer): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    sendJson(res, 400, { message: 'Bad request: malformed JSON body' });
    return;
  }
  const ops = (Array.isArray(parsed) ? parsed : [parsed]) as Json[];
  const entries = ops.map((op) => gqlGraphQL(String((op as Json).query ?? ''), ((op as Json).variables ?? {}) as Json));
  sendJson(res, 200, Array.isArray(parsed) ? entries : entries[0]);
}

// ---------------------------------------------------------------- MCP

const MCP_TOOLS = [
  { name: 'create_repo', description: 'Create a new repository in the forge.', inputSchema: { type: 'object', properties: { owner: { type: 'string', minLength: 1 }, name: { type: 'string', minLength: 1 }, description: { type: 'string' }, private: { type: 'boolean' } }, required: ['owner', 'name'] } },
  { name: 'get_repo', description: 'Get a repository by owner and name.', inputSchema: { type: 'object', properties: { owner: { type: 'string', minLength: 1 }, repo: { type: 'string', minLength: 1 } }, required: ['owner', 'repo'] } },
  { name: 'create_issue', description: 'Create an issue in a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string', minLength: 1 }, repo: { type: 'string', minLength: 1 }, title: { type: 'string', minLength: 1 }, body: { type: 'string' }, labels: { type: 'array', items: { type: 'string' } } }, required: ['owner', 'repo', 'title'] } },
  { name: 'list_issues', description: 'List the issues of a repository, filtered by state when given.', inputSchema: { type: 'object', properties: { owner: { type: 'string', minLength: 1 }, repo: { type: 'string', minLength: 1 }, state: { type: 'string', enum: ['open', 'closed', 'all'] } }, required: ['owner', 'repo'] } },
  { name: 'create_pull_request', description: 'Open a pull request from a head branch to a base branch of a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string', minLength: 1 }, repo: { type: 'string', minLength: 1 }, title: { type: 'string', minLength: 1 }, body: { type: 'string' }, head: { type: 'string', minLength: 1 }, base: { type: 'string', minLength: 1 } }, required: ['owner', 'repo', 'title', 'head', 'base'] } },
  { name: 'merge_pull_request', description: 'Squash-merge an open pull request.', inputSchema: { type: 'object', properties: { owner: { type: 'string', minLength: 1 }, repo: { type: 'string', minLength: 1 }, pull_number: { type: 'integer', minimum: 1 } }, required: ['owner', 'repo', 'pull_number'] } },
];

function mcpResult(result: Json): Json {
  return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
}

function mcpCallTool(owner: string, name: string, args: Json): Json {
  if (name === 'create_repo') {
    const repoName = String(args.name ?? '');
    const repo = createRepoRow(owner, repoName, args.private === true, String(args.description ?? ''));
    if (repo === null) throw new Error(`repository already exists: ${repoName}`);
    return { full_name: `${owner}/${repoName}`, name: repoName, private: args.private === true };
  }
  const repo = getRepo(owner, String(args.repo ?? ''));
  if (repo === undefined) throw new Error(`repository not found: ${owner}/${String(args.repo ?? '')}`);
  if (name === 'get_repo') return serializeRepo(repo);
  if (name === 'create_issue') return serializeIssue(createIssueRow(repo, args));
  if (name === 'list_issues') {
    const state = typeof args.state === 'string' ? args.state : undefined;
    return { issues: repo.issues.filter((issue) => state === undefined || issue.state === state).map(serializeIssue) };
  }
  if (name === 'create_pull_request') return serializePull(createPullRow(repo, args));
  if (name === 'merge_pull_request') {
    const pr = findPull(repo, Number(args.pull_number));
    if (pr === undefined) throw new Error('pull request not found');
    mergePullRows(repo, pr);
    return { number: pr.number, merged: pr.merged, state: pr.state.toUpperCase() };
  }
  throw new Error(`unknown tool: ${name}`);
}

function requireMcpArgs(tool: Json, args: Json): void {
  for (const key of Array.isArray(tool.required) ? (tool.required as string[]) : []) {
    if (args[key] === undefined || args[key] === null) throw new Error(`missing required argument: ${key}`);
  }
}

async function handleMcp(req: IncomingMessage, res: ServerResponse, body: Buffer): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  const rpc = parsed as Json;
  const id = rpc.id;
  const respond = (result: Json | null, error: { code: number; message: string } | null): void => {
    if (error !== null) {
      sendJson(res, error.code === -32700 ? 400 : 200, { jsonrpc: '2.0', id: id ?? null, error });
      return;
    }
    sendJson(res, 200, { jsonrpc: '2.0', id: id ?? null, result });
  };
  const method = String(rpc.method ?? '');
  if (method === 'server/discover') {
    respond({ supportedVersions: ['2026-07-28'], capabilities: { tools: {} }, serverInfo: { name: 'github-core-clone-forge', version: '1.0' } }, null);
    return;
  }
  if (method === 'initialize') {
    respond({ protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'github-core-clone-forge', version: '1.0' } }, null);
    return;
  }
  if (method === 'notifications/initialized') {
    res.writeHead(200, { 'content-type': JSON_TYPE, 'content-length': '2' });
    res.end('{}');
    return;
  }
  if (method === 'tools/list') {
    respond({ tools: MCP_TOOLS }, null);
    return;
  }
  if (method === 'tools/call') {
    const name = String((rpc.params as Json | undefined)?.name ?? '');
    const args = (((rpc.params as Json | undefined)?.arguments ?? {}) as Json);
    const tool = MCP_TOOLS.find((t) => t.name === name);
    if (tool === undefined) {
      respond(null, { code: -32602, message: `Unknown tool: ${name}` });
      return;
    }
    try {
      requireMcpArgs(tool, args);
      respond(mcpResult(mcpCallTool(OWNER, tool.name, args)), null);
    } catch (err) {
      respond(null, { code: -32602, message: err instanceof Error ? err.message : String(err) });
    }
    return;
  }
  respond(null, { code: -32601, message: `Method not found: ${method}` });
}

// ---------------------------------------------------------------- entry point

export function createApp(): Server {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://forge');
      const pathname = url.pathname;
      const query = url.searchParams;
      const method = (req.method ?? 'GET').toUpperCase();
      if (pathname === '/healthz') {
        res.writeHead(200, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength('{"ok":true}\n') });
        res.end('{"ok":true}\n');
        return;
      }
      if (!authOk(req)) {
        sendJson(res, 401, { message: 'Bad credentials' });
        return;
      }
      const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
      const gitMatch = pathname.match(/^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/);
      if (gitMatch) { await handleGitHttp(req, res, pathname, method, body, query); return; }
      if (pathname === '/api/graphql') { await handleGraphql(req, res, body); return; }
      if (pathname === '/mcp') { await handleMcp(req, res, body); return; }
      const apiMatch = pathname.match(/^\/api\/v3(\/.*)?$/);
      if (apiMatch) { await handleApi(res, req, pathname.slice('/api/v3'.length) || '/', method, body, query); return; }
      sendJson(res, 404, { message: 'Not Found' });
    } catch (err) {
      if (err instanceof SyntaxError) { sendJson(res, 400, { message: 'Bad request: malformed JSON body' }); return; }
      sendError(res, err);
    }
  });
}
