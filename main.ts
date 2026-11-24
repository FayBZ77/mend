// main.ts is mend, the CLI SPEC.md specifies. It implements all of SPEC.md: the command line, output and exit
// codes, safe paths, format detection, unified diffs (section 6), SEARCH/REPLACE blocks (section 7), V4A patches
// (section 8), JSON edits (section 9), line matching at three tiers (section 5) and the all-or-nothing write
// (section 10). Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** A file split the way section 3 reads it: its own line break, its lines, whether it ends with a break. */
interface FileParts {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileParts {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  // The split keeps the empty piece after a final break: it is the file's last element, and a patch line
  // that is empty can match it there (the piece is the break itself, not a line of the file).
  const lines = text.split(br);
  return { lines, br, final: lines[lines.length - 1] === '' };
}

function joinFile(p: FileParts): string {
  return p.lines.join(p.br);
}

/** How many of a split file's elements are lines of the file (all but the final-break piece). */
function realCount(lines: string[]): number {
  return lines.length - (lines.length > 0 && lines[lines.length - 1] === '' ? 1 : 0);
}

/** Section 5: line equality and occurrence search at the three tiers. */
const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

function eqAt(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

function occurrences(lines: string[], old: string[], tier: number): number[] {
  const res: number[] = [];
  if (old.length === 0) return res;
  for (let i = 0; i + old.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < old.length; j++) {
      if (!eqAt(lines[i + j]!, old[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) res.push(i);
  }
  return res;
}

function findTier(lines: string[], old: string[], strict: boolean): { tier: number; pos: number[] } | null {
  for (const t of strict ? [0] : [0, 1, 2]) {
    const pos = occurrences(lines, old, t);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

type SegKind = 'ctx' | 'old' | 'new';
interface SegEntry {
  kind: SegKind;
  text: string;
}

const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0];

function reindent(t: string, f: string, p: string): string {
  if (t === '' || t.trim() === '') return t;
  if (t.startsWith(p)) return f + t.slice(p.length);
  return t;
}

/** The lines that replace a matched run: context lines are the file's own, new lines are the patch's (re-indented at tier 2).
 *  lastProv says what the segment's last line is: 'virtual' when it is the file's final-break piece itself. */
function buildSegment(
  fileLines: string[],
  pos: number,
  oE: SegEntry[],
  nE: SegEntry[],
  tier: number,
): { seg: string[]; lastProv: 'virtual' | 'real' | null } {
  const oCtx: number[] = [];
  oE.forEach((e, i) => {
    if (e.kind === 'ctx') oCtx.push(i);
  });
  const f = tier === 2 ? leadWs(fileLines[pos] ?? '') : '';
  const p = tier === 2 ? leadWs(oE[0]?.text ?? '') : '';
  const rc = realCount(fileLines);
  const out: string[] = [];
  let lastProv: 'virtual' | 'real' | null = null;
  let ctxCount = 0;
  for (const e of nE) {
    if (e.kind === 'ctx') {
      const fi = pos + oCtx[ctxCount++]!;
      out.push(fileLines[fi]!);
      lastProv = fi === rc && fileLines[fi] === '' ? 'virtual' : 'real';
    } else {
      out.push(tier === 2 ? reindent(e.text, f, p) : e.text);
      lastProv = 'real';
    }
  }
  return { seg: out, lastProv };
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const parts = splitFile(before);
      if (line < 0 || line > realCount(parts.lines)) throw new Fail('no-match', p);
      parts.lines.splice(line, 0, ...add);
      tree.now.set(p, joinFile(parts));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** Section 6: unified diffs. */

interface UBody {
  kind: SegKind | 'bs';
  text: string;
}
interface UHunk {
  a: number;
  body: UBody[];
}
interface USection {
  diffOld?: string;
  diffNew?: string;
  oldPath?: string;
  newPath?: string;
  renameFrom?: string;
  renameTo?: string;
  newFile: boolean;
  delFile: boolean;
  hasPair: boolean;
  hunks: UHunk[];
}

function hdrPath(line: string): string {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function applyHunks(parts: FileParts, hunks: UHunk[], strict: boolean, path: string): void {
  let d = 0;
  for (const h of hunks) {
    const oE: SegEntry[] = h.body.filter((b) => b.kind === 'ctx' || b.kind === 'old') as SegEntry[];
    const nE: SegEntry[] = h.body.filter((b) => b.kind === 'ctx' || b.kind === 'new') as SegEntry[];
    let bsAfter = false;
    for (let k = h.body.length - 1; k >= 0; k--) {
      const b = h.body[k]!;
      if (b.kind === 'ctx' || b.kind === 'new') {
        bsAfter = h.body[k + 1]?.kind === 'bs';
        break;
      }
    }
    const xl = parts.lines;
    const finalBr = xl.length > 0 && xl[xl.length - 1] === '';
    const rc = realCount(xl);
    if (oE.length === 0) {
      const pos = Math.min(h.a + d, rc);
      const seg = nE.map((e) => e.text);
      const touches = pos === rc;
      xl.splice(pos, 0, ...seg);
      if (touches && seg.length > 0) {
        if (!bsAfter) {
          if (xl[xl.length - 1] !== '') xl.push('');
        } else if (finalBr && xl[xl.length - 1] === '') {
          xl.pop();
        }
      }
      d += seg.length;
      continue;
    }
    const found = findTier(xl, oE.map((e) => e.text), strict);
    if (!found) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let pos = found.pos[0]!;
    for (const p of found.pos) if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
    const { seg, lastProv } = buildSegment(xl, pos, oE, nE, found.tier);
    const touches = pos + oE.length === rc || pos + oE.length === xl.length;
    const consumedVirtual = pos + oE.length === xl.length;
    xl.splice(pos, oE.length, ...seg);
    if (touches) {
      if (!bsAfter) {
        if (xl[xl.length - 1] !== '') xl.push('');
        else if (lastProv === 'real' && consumedVirtual && seg[seg.length - 1] === '') xl.push('');
      } else if (lastProv === 'virtual') {
        xl.pop();
      } else if (lastProv === 'real' && seg[seg.length - 1] !== '' && xl[xl.length - 1] === '') {
        xl.pop();
      }
    }
    d += nE.length - oE.length;
  }
}

function unifiedEdit(sec: USection, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.oldPath ?? sec.renameFrom ?? sec.diffOld;
    const newP = sec.newPath ?? sec.renameTo ?? sec.diffNew;
    if (sec.newFile || oldP === '/dev/null') {
      const p = newP!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const outLines: string[] = [];
      let lastPlusBs = false;
      for (const h of sec.hunks) {
        h.body.forEach((b, bi) => {
          if (b.kind === 'new') {
            outLines.push(b.text);
            lastPlusBs = h.body[bi + 1]?.kind === 'bs';
          }
        });
      }
      tree.now.set(p, outLines.length === 0 ? '' : outLines.join('\n') + (lastPlusBs ? '' : '\n'));
      return;
    }
    if (sec.delFile || newP === '/dev/null') {
      const p = oldP!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const src = oldP!;
    const dst = newP!;
    if (!safe(src)) throw new Fail('unsafe', src);
    if (dst !== src && !safe(dst)) throw new Fail('unsafe', dst);
    const before = tree.get(src);
    if (before === null) throw new Fail('missing', src);
    if (dst !== src && tree.get(dst) !== null) throw new Fail('exists', dst);
    const parts = splitFile(before);
    applyHunks(parts, sec.hunks, strict, src);
    const text = joinFile(parts);
    if (dst !== src) {
      tree.now.set(src, null);
      tree.now.set(dst, text);
      tree.moves.push([src, dst]);
    } else {
      tree.now.set(src, text);
    }
  };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  const startSection = (): USection => {
    const s: USection = { newFile: false, delFile: false, hasPair: false, hunks: [] };
    sections.push(s);
    return s;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const ln = i + 1;
    if (line.startsWith('diff --git ')) {
      const m = /^a\/(.*) b\/(.*)$/.exec(line.slice(11));
      if (!m) throw new Exit2(`error: parse ${ln}`);
      cur = startSection();
      cur.diffOld = m[1];
      cur.diffNew = m[2];
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur === null || cur.hasPair || cur.hunks.length > 0) cur = startSection();
      cur.oldPath = hdrPath(line);
      cur.newPath = hdrPath(lines[i + 1]!);
      cur.hasPair = true;
      i += 2;
      continue;
    }
    if (line.startsWith('--- ') && cur !== null && cur.hunks.length === 0) {
      throw new Exit2(`error: parse ${ln + 1}`);
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${ln}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m) throw new Exit2(`error: parse ${ln}`);
      const hunk: UHunk = { a: parseInt(m[1]!, 10), body: [] };
      i++;
      while (i < lines.length) {
        const bl = lines[i]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        const c = bl[0];
        if (bl === '') hunk.body.push({ kind: 'ctx', text: '' });
        else if (c === ' ') hunk.body.push({ kind: 'ctx', text: bl.slice(1) });
        else if (c === '-') hunk.body.push({ kind: 'old', text: bl.slice(1) });
        else if (c === '+') hunk.body.push({ kind: 'new', text: bl.slice(1) });
        else if (c === '\\') hunk.body.push({ kind: 'bs', text: bl.slice(1) });
        else break;
        i++;
      }
      while (hunk.body.length > 0) {
        const lastB = hunk.body[hunk.body.length - 1]!;
        if (lastB.kind === 'ctx' && lastB.text === '') hunk.body.pop();
        else break;
      }
      cur.hunks.push(hunk);
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice(12).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice(10).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.delFile = true;
    }
    i++;
  }
  return sections.map((s) => unifiedEdit(s, strict));
}

/** Section 7: SEARCH/REPLACE blocks. */

function srEdit(p: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (oldLines.length === 0) {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    const parts = splitFile(before);
    const found = findTier(parts.lines, oldLines, strict);
    if (!found) throw new Fail('no-match', p);
    if (found.pos.length > 1) throw new Fail('ambiguous', p);
    const pos = found.pos[0]!;
    const { seg } = buildSegment(
      parts.lines,
      pos,
      oldLines.map((t) => ({ kind: 'old' as SegKind, text: t })),
      newLines.map((t) => ({ kind: 'new' as SegKind, text: t })),
      found.tier,
    );
    parts.lines.splice(pos, oldLines.length, ...seg);
    tree.now.set(p, joinFile(parts));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let searchFrom = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLn = i + 1;
    let p: string | null = null;
    for (let k = i - 1; k >= searchFrom; k--) {
      const l = lines[k]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      p = l.trim();
      break;
    }
    if (p === null) {
      if (prevPath !== null) p = prevPath;
      else throw new Exit2(`error: parse ${searchLn}`);
    }
    let j = i + 1;
    while (j < lines.length && lines[j]!.trimEnd() !== '=======' && lines[j]!.trimEnd() !== '>>>>>>> REPLACE') j++;
    if (j >= lines.length || lines[j]!.trimEnd() !== '=======') throw new Exit2(`error: parse ${searchLn}`);
    const oldLines = lines.slice(i + 1, j);
    let k = j + 1;
    while (k < lines.length && lines[k]!.trimEnd() !== '>>>>>>> REPLACE') k++;
    if (k >= lines.length) throw new Exit2(`error: parse ${searchLn}`);
    const newLines = lines.slice(j + 1, k);
    edits.push(srEdit(p, oldLines, newLines, strict));
    prevPath = p;
    searchFrom = k + 1;
    i = k + 1;
  }
  return edits;
}

/** Section 8: V4A patches. */

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: SegEntry[];
}

function v4aAdd(path: string, bodyLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, bodyLines.length === 0 ? '' : bodyLines.join('\n') + '\n');
  };
}

function v4aDelete(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdate(path: string, secLn: number, raw: { text: string; ln: number }[], strict: boolean): Edit {
  let moveTo: string | undefined;
  let idx = 0;
  if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to: ')) {
    moveTo = raw[0]!.text.slice(12).trim();
    idx = 1;
  }
  const chunks: VChunk[] = [];
  let cur: VChunk | null = null;
  for (; idx < raw.length; idx++) {
    const { text: l, ln } = raw[idx]!;
    if (l.startsWith('@@')) {
      cur = { anchor: l.slice(2).trim() || null, eof: false, body: [] };
      chunks.push(cur);
    } else if (l.trim() === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${ln}`);
      cur.eof = true;
      cur = null;
    } else if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
      if (cur === null) {
        cur = { anchor: null, eof: false, body: [] };
        chunks.push(cur);
      }
      if (l === '') cur.body.push({ kind: 'ctx', text: '' });
      else cur.body.push({ kind: l[0] === ' ' ? 'ctx' : l[0] === '-' ? 'old' : 'new', text: l.slice(1) });
    } else {
      throw new Exit2(`error: parse ${ln}`);
    }
  }
  if (chunks.length === 0 && moveTo === undefined) throw new Exit2(`error: parse ${secLn}`);
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== undefined && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== undefined && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const parts = splitFile(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        let hit = -1;
        for (const t of strict ? [0] : [0, 1, 2]) {
          for (let k = cursor; k < parts.lines.length; k++) {
            if (eqAt(parts.lines[k]!, ch.anchor, t)) {
              hit = k;
              break;
            }
          }
          if (hit >= 0) break;
        }
        if (hit < 0) throw new Fail('no-match', path);
        cursor = hit + 1;
      }
      const oE = ch.body.filter((b) => b.kind !== 'new');
      const nE = ch.body.filter((b) => b.kind !== 'old');
      if (oE.length === 0) {
        const pos = ch.eof ? parts.lines.length : Math.min(cursor, parts.lines.length);
        const seg = nE.map((e) => e.text);
        parts.lines.splice(pos, 0, ...seg);
        cursor = pos + seg.length;
      } else {
        const oTexts = oE.map((e) => e.text);
        let found: { tier: number; pos: number } | null = null;
        for (const t of strict ? [0] : [0, 1, 2]) {
          const occ = occurrences(parts.lines, oTexts, t).filter(
            (pp) => pp >= cursor && (!ch.eof || pp + oTexts.length === parts.lines.length || pp + oTexts.length === realCount(parts.lines)),
          );
          if (occ.length > 0) {
            found = { tier: t, pos: occ[0]! };
            break;
          }
        }
        if (!found) throw new Fail('no-match', path);
        const { seg } = buildSegment(parts.lines, found.pos, oE, nE, found.tier);
        parts.lines.splice(found.pos, oE.length, ...seg);
        cursor = found.pos + seg.length;
      }
    }
    const text = joinFile(parts);
    if (moveTo !== undefined) {
      tree.now.set(path, null);
      tree.now.set(moveTo, text);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, text);
    }
  };
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last > first && blank(lines[last]!)) last--;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice(13).trim();
      i++;
      const body: { text: string; bare: boolean }[] = [];
      while (i < last && !isSectionStart(lines[i]!)) {
        const bl = lines[i]!;
        if (bl.startsWith('+')) body.push({ text: bl.slice(1), bare: false });
        else if (bl === '') body.push({ text: '', bare: true });
        else throw new Exit2(`error: parse ${i + 1}`);
        i++;
      }
      while (body.length > 0 && body[body.length - 1]!.bare) body.pop();
      edits.push(v4aAdd(path, body.map((b) => b.text)));
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      edits.push(v4aDelete(line.slice(16).trim()));
      i++;
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice(16).trim();
      const secLn = i + 1;
      i++;
      const raw: { text: string; ln: number }[] = [];
      while (i < last && !isSectionStart(lines[i]!)) {
        raw.push({ text: lines[i]!, ln: i + 1 });
        i++;
      }
      while (raw.length > 0 && raw[raw.length - 1]!.text === '') raw.pop();
      edits.push(v4aUpdate(path, secLn, raw, strict));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? parseUnified(lines, strict)
          : kind === 'search-replace'
            ? parseSearchReplace(lines, strict)
            : parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesLen = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesLen;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const keyed: { key: string; text: string }[] = [];
  const used = new Set<string>();
  for (const [o, n] of tree.moves) {
    if (used.has(o) || used.has(n)) continue;
    if (tree.original(o) !== null && tree.now.get(o) === null && tree.original(n) === null && tree.now.get(n) !== null) {
      keyed.push({ key: n, text: `R ${o} -> ${n}` });
      used.add(o);
      used.add(n);
    }
  }
  for (const p of tree.now.keys()) {
    if (used.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    keyed.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  keyed.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rows = keyed.map((r) => r.text);
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
