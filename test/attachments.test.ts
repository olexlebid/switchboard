import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { attachmentsPrompt, classify, loadBatch, saveAttachments, sanitizeFileName, LIMITS } from '../packages/core/attachments';

let dir: string;
let project: string;
const git = (...a: string[]) => execFileSync('git', a, { cwd: project, encoding: 'utf8' }).trim();
const fixture = (n: string) => readFileSync(join(import.meta.dirname, 'fixtures', n));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sb-att-'));
  project = join(dir, 'site');
  mkdirSync(project);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: project });
  execFileSync('git', ['config', 'user.email', 't@e.c'], { cwd: project });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: project });
  writeFileSync(join(project, 'README.md'), '# s\n');
  execFileSync('git', ['add', '-A'], { cwd: project });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: project });
  delete process.env.SB_FFMPEG;
});
afterEach(() => { delete process.env.SB_FFMPEG; rmSync(dir, { recursive: true, force: true }); });

const png = () => sharp({ create: { width: 40, height: 30, channels: 3, background: '#336699' } }).png().toBuffer();

describe('sanitizeFileName / classify', () => {
  it('strips paths, shell characters and keeps the extension', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFileName('C:\\Users\\me\\design v2 (final).PNG')).toBe('design_v2_final_.png');
    expect(sanitizeFileName('.hidden')).toBe('hidden');
    expect(sanitizeFileName('Gesellschaftstanz für Paare.pdf')).toBe('Gesellschaftstanz_für_Paare.pdf');
    expect(sanitizeFileName('макет 1440.jpg')).toBe('макет_1440.jpg');
    expect(sanitizeFileName('a'.repeat(300) + '.png').length).toBeLessThanOrEqual(LIMITS.nameLength);
    expect(sanitizeFileName('$(rm -rf).png')).not.toMatch(/[$()\s]/);
  });
  it('knows the supported types and refuses executables', () => {
    expect(classify('x.AVIF')).toMatchObject({ kind: 'image', ext: 'avif' });
    expect(classify('x.docx')?.kind).toBe('doc');
    expect(classify('x.mp3')?.kind).toBe('audio');
    expect(classify('x.exe')).toBeUndefined();
    expect(classify('x.sh')).toBeUndefined();
    expect(classify('noext')).toBeUndefined();
  });
});

describe('saveAttachments', () => {
  it('stores files inside .sb/attachments and keeps git status clean (local exclude, no tracked changes)', async () => {
    const batch = await saveAttachments(project, [{ name: 'hero.png', data: await png() }, { name: 'notes.txt', data: Buffer.from('hello') }]);
    expect(batch.rejected).toEqual([]);
    expect(batch.items.map((i) => i.name)).toEqual(['hero.png', 'notes.txt']);
    expect(batch.items[0]!.path.startsWith('.sb/attachments/a-')).toBe(true);
    expect(existsSync(join(project, batch.items[0]!.path))).toBe(true);
    expect(git('status', '--porcelain')).toBe('');
    expect(readFileSync(join(project, '.git/info/exclude'), 'utf8')).toContain('.sb/attachments/');
    // idempotent: the exclude line is added only once
    await saveAttachments(project, [{ name: 'a.txt', data: Buffer.from('x') }]);
    expect(readFileSync(join(project, '.git/info/exclude'), 'utf8').match(/\.sb\/attachments\//g)).toHaveLength(1);
  });

  it('converts avif to png, which the agents can read', async () => {
    const avif = await sharp(await png()).avif().toBuffer();
    const b = await saveAttachments(project, [{ name: 'Фото.avif', data: avif }]);
    const item = b.items[0]!;
    expect(item.readPaths).toHaveLength(1);
    expect(item.readPaths[0]).toMatch(/\.png$/);
    expect((await sharp(join(project, item.readPaths[0]!)).metadata()).format).toBe('png');
    expect(item.note).toMatch(/avif.*png/);
  });

  it('reads a docx as text and an xlsx as CSV (all sheets, quoting)', async () => {
    const b = await saveAttachments(project, [{ name: 'kurse.docx', data: fixture('sample.docx') }, { name: 'preise.xlsx', data: fixture('sample.xlsx') }]);
    const docx = b.items[0]!;
    expect(readFileSync(join(project, docx.readPaths[0]!), 'utf8')).toContain('Kindertanz ab 3 Jahren');
    const xlsx = b.items[1]!;
    const csv = readFileSync(join(project, xlsx.readPaths[0]!), 'utf8');
    expect(csv).toContain('## Sheet: Kurse');
    expect(csv).toContain('Hip-Hop,13-22,"Mittwoch, ""Abend"""');
    expect(csv).toContain('## Sheet: Preise');
    expect(csv).toContain('10er Karte,120');
    expect(xlsx.note).toMatch(/2 арк/);
  });

  it('refuses unsupported, empty, disguised and oversized files but keeps the good ones', async () => {
    const b = await saveAttachments(project, [
      { name: 'run.exe', data: Buffer.from('MZ') },
      { name: 'empty.txt', data: Buffer.alloc(0) },
      { name: 'fake.pdf', data: Buffer.from('<html>not a pdf</html>') },
      { name: 'fake.png', data: Buffer.from('not an image at all') },
      { name: 'fake.docx', data: Buffer.from('plain text pretending to be docx') },
      { name: 'big.docx', data: Buffer.concat([Buffer.from('PK'), Buffer.alloc(LIMITS.perOfficeFile)]) },
      { name: 'ok.txt', data: Buffer.from('fine') },
    ]);
    expect(b.items.map((i) => i.name)).toEqual(['ok.txt']);
    expect(Object.fromEntries(b.rejected.map((r) => [r.name, r.reason]))).toMatchObject({
      'run.exe': expect.stringMatching(/не підтримується/),
      'empty.txt': expect.stringMatching(/порожній/),
      'fake.pdf': expect.stringMatching(/не PDF/),
      'fake.png': expect.stringMatching(/зображення/),
      'fake.docx': expect.stringMatching(/Office/),
      'big.docx': expect.stringMatching(/завеликий/),
    });
  });

  it('limits the number of files per message and keeps names unique', async () => {
    const files = Array.from({ length: LIMITS.count + 2 }, () => ({ name: 'same.txt', data: Buffer.from('x') }));
    const b = await saveAttachments(project, files);
    expect(b.items).toHaveLength(LIMITS.count);
    expect(b.rejected).toHaveLength(2);
    expect(new Set(b.items.map((i) => i.path)).size).toBe(LIMITS.count);
  });

  it('video: frames via ffmpeg when available, a clear note when not; audio is stored with a note', async () => {
    // hide any real ffmpeg on this machine so the "not installed" branch is what gets tested
    const realPath = process.env.PATH;
    process.env.PATH = join(dir, 'empty-bin');
    let b1: Awaited<ReturnType<typeof saveAttachments>>;
    try {
      b1 = await saveAttachments(project, [{ name: 'clip.mp4', data: Buffer.from('fake video') }, { name: 'voice.mp3', data: Buffer.from('fake audio') }]);
    } finally {
      process.env.PATH = realPath;
    }
    expect(b1.items[0]!.readPaths).toEqual([]);
    expect(b1.items[0]!.note).toMatch(/ffmpeg не знайдено/);
    expect(b1.items[1]!.note).toMatch(/не розшифровується/);

    // a fake ffmpeg that writes three frames
    const fake = join(dir, 'ffmpeg');
    writeFileSync(fake, '#!/bin/sh\nfor last; do :; done\nout=$(dirname "$last")\nfor i in 01 02 03; do echo frame > "$out/frame-$i.jpg"; done\n');
    chmodSync(fake, 0o755);
    process.env.SB_FFMPEG = fake;
    const b2 = await saveAttachments(project, [{ name: 'clip.mp4', data: Buffer.from('fake video') }]);
    expect(b2.items[0]!.readPaths).toHaveLength(3);
    expect(b2.items[0]!.readPaths[0]).toMatch(/clip\.mp4\.frames\/frame-01\.jpg$/);
    expect(b2.items[0]!.note).toMatch(/3 кадр/);
  });

  it('a conversion failure is a note, not an exception', async () => {
    const zipLike = Buffer.concat([Buffer.from('PK'), Buffer.from('this is not a real docx archive')]);
    const b = await saveAttachments(project, [{ name: 'broken.docx', data: zipLike }]);
    expect(b.items).toHaveLength(1);
    expect(b.items[0]!.readPaths).toEqual([]);
    expect(b.items[0]!.note).toMatch(/конвертація не вдалася/);
  });
});

describe('loadBatch / attachmentsPrompt', () => {
  it('round-trips the manifest and refuses directories outside .sb/attachments', async () => {
    const b = await saveAttachments(project, [{ name: 'a.txt', data: Buffer.from('x') }]);
    expect(loadBatch(project, b.dir).items).toHaveLength(1);
    expect(() => loadBatch(project, '../..')).toThrow(/Невірний/);
    expect(() => loadBatch(project, '.sb')).toThrow(/Невірний/);
  });

  it('lists what to read and warns agy about PDFs', () => {
    const items = [{ name: 'макет.png', kind: 'image' as const, size: 1, path: '.sb/attachments/a/x.png', readPaths: ['.sb/attachments/a/x.png'] }, { name: 'talk.mp3', kind: 'audio' as const, size: 1, path: 'p', readPaths: [], note: 'аудіо не розшифровується' }];
    const p = attachmentsPrompt(items, 'agy');
    expect(p).toContain('макет.png (image) → read: .sb/attachments/a/x.png');
    expect(p).toContain('talk.mp3 (audio) → cannot be read');
    expect(p).toContain('PDF');
    expect(attachmentsPrompt([], 'claude')).toBe('');
  });
});
