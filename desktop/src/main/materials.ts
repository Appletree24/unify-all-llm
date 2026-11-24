import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { Material, MaterialSelection, StagedMaterial } from '../shared/api.js';

const run = promisify(execFile);
const toolsDir = dirname(fileURLToPath(import.meta.url)).replace(/\.asar([/\\])/, '.asar.unpacked$1');
const maxText = 24000;
const staged = new Map<string, { cwd: string; temp: string; hash: string; item: StagedMaterial }>();
let stagingDir: string | undefined;

const audioTypes: Record<string, string> = {
  '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.flac': 'audio/flac', '.weba': 'audio/webm',
  '.aiff': 'audio/aiff', '.aif': 'audio/aiff', '.caf': 'audio/x-caf', '.amr': 'audio/amr',
};

async function transcribeAudio(native: string, file: string): Promise<string> {
  if (!existsSync(native)) throw new Error('当前桌面端缺少本机语音转写工具');
  const recognize = async (path: string) => {
    try {
      const { stdout } = await run(native, ['audio', path], { timeout: 600000, maxBuffer: 4 * 1024 * 1024 });
      return stdout.trim();
    } catch (error) {
      const failure = error as { code?: number; stderr?: string; killed?: boolean };
      if (failure.code === 65) return null; // Core Audio could not open the source container.
      const reason = failure.stderr?.match(/^Unify: (.+)$/m)?.[1];
      throw new Error(reason || (failure.killed ? '本机语音转写超时' : '本机语音识别服务运行失败'));
    }
  };
  const direct = await recognize(file);
  if (direct !== null) return direct;

  // Chromium can record Opus in an MP4 container that Core Audio cannot decode.
  const wav = file + '.pcm.wav';
  try {
    try {
      await run('ffmpeg', ['-nostdin', '-v', 'error', '-protocol_whitelist', 'file',
        '-format_whitelist', 'mov,matroska,webm,ogg,mp3,wav,aac,flac,aiff,caf,amr,asf',
        '-i', file, '-map', '0:a:0', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav],
      { timeout: 90000, windowsHide: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('系统无法解码此录音，可安装 FFmpeg 或导入 WAV 文件');
      throw new Error('无法解码录音，请检查文件是否完整');
    }
    const result = await recognize(wav);
    if (result === null) throw new Error('无法读取转换后的录音');
    return result;
  } finally {
    rmSync(wav, { force: true });
  }
}

async function extract(file: string, bytes: Buffer, mime: string) {
  const ext = extname(file).toLowerCase();
  const native = join(toolsDir, 'material-text');
  const cmd = async (bin: string, args: string[]) =>
    (await run(bin, args, { timeout: 90000, maxBuffer: 4 * 1024 * 1024, windowsHide: true })).stdout;
  let text = '', extraction = '';
  try {
    if (['.docx', '.pptx', '.xlsx'].includes(ext)) {
      text = await cmd('python3', [join(toolsDir, 'office-text.py'), file]);
      extraction = '文档文字';
    } else if (ext === '.pdf') {
      text = existsSync(native) ? await cmd(native, ['pdf', file]) : await cmd('pdftotext', ['-l', '40', file, '-']);
      extraction = 'PDF 文字（最多前 40 页）';
    } else if (mime.startsWith('image/') && ext !== '.svg') {
      text = existsSync(native) ? await cmd(native, ['image', file]) : await cmd('tesseract', [file, 'stdout']);
      extraction = '图片识别文字';
    } else if (mime.startsWith('audio/')) {
      text = await transcribeAudio(native, file);
      extraction = text ? '本机语音转写' : '录音已读取，未识别到语音';
    } else if (mime.startsWith('video/')) {
      text = await cmd(native, ['video', file]);
      extraction = '视频画面文字（最多 8 帧）';
    } else if (['.rtf', '.doc', '.odt'].includes(ext) && process.platform === 'darwin') {
      text = await cmd('/usr/bin/textutil', ['-convert', 'txt', '-stdout', file]);
      extraction = '文档文字';
    } else if (!bytes.subarray(0, 8192).includes(0)) {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      extraction = '文件正文';
    }
  } catch (error) {
    if (mime.startsWith('audio/')) extraction = error instanceof Error ? error.message : '本机转写失败';
  }
  text = text.trim();
  if (!text && !mime.startsWith('audio/')) extraction = '仅原件，纯文本模型需文字说明';
  if (text.length > maxText) extraction += '（取前 ' + maxText + ' 字）';
  return { text: text.slice(0, maxText), extraction };
}

export async function stageMaterial(cwd: string, rawName: string, mime: string, data: ArrayBuffer): Promise<StagedMaterial> {
  if (!(data instanceof ArrayBuffer) || !data.byteLength || data.byteLength > 64 * 1024 * 1024) throw new Error('请选择 1 B 到 64 MB 之间的文件');
  const name = basename(rawName.replaceAll('\\', '/')).replace(/[^\p{L}\p{N}_.() -]/gu, '_').replace(/[. ]+$/g, '').slice(0, 128) || 'material';
  mime = audioTypes[extname(name).toLowerCase()] ?? mime;
  const id = randomUUID();
  stagingDir ??= mkdtempSync(join(tmpdir(), 'unify-inputs-'));
  const temp = join(stagingDir, id + extname(name));
  const bytes = Buffer.from(data);
  await writeFile(temp, bytes, { flag: 'wx', mode: 0o600 });
  try {
    const item = { id, name, mime, bytes: bytes.length, ...await extract(temp, bytes, mime) };
    staged.set(id, { cwd, temp, item, hash: createHash('sha256').update(bytes).digest('hex') });
    return item;
  } catch (err) { rmSync(temp, { force: true }); throw err; }
}

export function discardMaterial(cwd: string, id: string) {
  const entry = staged.get(id);
  if (entry?.cwd !== cwd) return;
  staged.delete(id);
  rmSync(entry.temp, { force: true });
}

export function clearMaterials() {
  staged.clear();
  if (stagingDir) rmSync(stagingDir, { recursive: true, force: true });
  stagingDir = undefined;
}

export function commitMaterials(cwd: string, selections: MaterialSelection[]): Material[] {
  if (selections.length > 12) throw new Error('每轮最多添加 12 份材料');
  return selections.map(({ id, note }) => {
    const entry = staged.get(id);
    if (!entry || entry.cwd !== cwd) throw new Error('材料已失效，请重新添加');
    const { id: _id, ...item } = entry.item;
    const relative = ['.unify', 'materials', entry.hash, item.name].join('/');
    const dest = resolve(cwd, relative);
    mkdirSync(dirname(dest), { recursive: true });
    if (!realpathSync(dirname(dest)).startsWith(realpathSync(cwd) + sep)) throw new Error('材料目录越出当前项目');
    if (!existsSync(dest)) {
      const temp = dest + '.' + randomUUID() + '.tmp';
      try { copyFileSync(entry.temp, temp); renameSync(temp, dest); }
      finally { rmSync(temp, { force: true }); }
    }
    return { ...item, file: relative, note: note.trim() };
  });
}
