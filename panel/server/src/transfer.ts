// 互传：宿主机文件中转。面板通过挂载卷读写宿主机 /home/rogerwi/uploads 目录，
// iOS 快捷指令等外部工具可直接往该目录推送文件，面板内浏览/上传/下载/删除。

import { readdirSync, statSync, unlinkSync, existsSync, mkdirSync, writeFileSync, createReadStream, renameSync, readFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { appendPanelLog } from './logs.js';

const TRANSFER_DIR = process.env.WOC_TRANSFER_DIR || '/data/uploads';

export interface TransferFile {
  name: string;
  size: number;
  mtime: number; // epoch ms
}

function safeName(name: string): boolean {
  return !!name
    && name.length <= 200
    && !name.includes('/')
    && !name.includes('\0')
    && !name.includes('\\')
    && name !== '.'
    && name !== '..';
}

// 启动时确保目录存在
export function ensureTransferDir(): void {
  if (!existsSync(TRANSFER_DIR)) {
    mkdirSync(TRANSFER_DIR, { recursive: true });
    appendPanelLog('INFO', `互传目录已创建: ${TRANSFER_DIR}`);
  }
}

// 通过文件头魔数检测扩展名（覆盖常见格式）
const MAGIC: [string | RegExp, string][] = [
  [/^\x89PNG/, '.png'],
  [/^\xff\xd8\xff/, '.jpg'],
  [/^GIF8/, '.gif'],
  [/^%PDF/, '.pdf'],
  [/^PK\x03\x04/, '.zip'],       // zip / docx / xlsx / pptx
  [/^RAR/, '.rar'],
  [/^\x37\x7a\xbc\xaf/, '.7z'],
  [/^\xd0\xcf\x11\xe0/, '.doc'],  // OLE2 — 旧版 Office
  [/^\x1f\x8b/, '.gz'],
  [/^BM/, '.bmp'],
  [/^RIFF.{4}WEBP/, '.webp'],
  [/^\x00\x00\x00\x20\x66\x74\x79\x70/, '.mp4'],
  [/^\x00\x00\x00\x1c\x66\x74\x79\x70/, '.mp4'],
  [/^\x00\x00\x00\x18\x66\x74\x79\x70/, '.mp4'],
  [/\x00\x00\x00\x28\x68\x65\x69\x63/, '.heic'],
  [/^\x49\x44\x33/, '.mp3'],
  [/^fLaC/, '.flac'],
  [/^\x52\x49\x46\x46.*WAVE/, '.wav'],
  [/^OggS/, '.ogg'],
  [/^\x00\x00\x00\x1a\x45\xdf\xa9/, '.mkv'],
  [/^MThd/, '.mid'],
  [/^{:/, '.json'],
];

function detectExt(name: string, filePath: string): string | undefined {
  if (extname(name)) return undefined; // 已有后缀
  try {
    const head = readFileSync(filePath, { length: 32 });
    const str = head.toString('latin1');
    for (const [magic, ext] of MAGIC) {
      if (typeof magic === 'string' ? str.startsWith(magic) : magic.test(str)) return ext;
    }
  } catch { /* ignore */ }
  return undefined;
}

// 列出文件（按时间倒序），支持搜索过滤
export function listTransferFiles(search?: string): TransferFile[] {
  if (!existsSync(TRANSFER_DIR)) return [];
  try {
    let files = readdirSync(TRANSFER_DIR, { withFileTypes: true })
      .filter(e => e.isFile())
      .map(e => {
        const stat = statSync(join(TRANSFER_DIR, e.name));
        return { name: e.name, size: stat.size, mtime: stat.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
    if (search) {
      const q = search.toLowerCase();
      files = files.filter(f => f.name.toLowerCase().includes(q));
    }
    return files;
  } catch {
    return [];
  }
}

// 手动检测所有无后缀文件的类型（点击"检测类型"按钮时调用）
export function detectFileTypes(): { name: string; ext: string }[] {
  if (!existsSync(TRANSFER_DIR)) return [];
  try {
    return readdirSync(TRANSFER_DIR, { withFileTypes: true })
      .filter(e => e.isFile() && !extname(e.name))
      .map(e => {
        const ext = detectExt(e.name, join(TRANSFER_DIR, e.name));
        return ext ? { name: e.name, ext } : null;
      })
      .filter(Boolean) as { name: string; ext: string }[];
  } catch {
    return [];
  }
}

// 写入上传文件
export function writeTransferFile(name: string, content: Buffer): void {
  if (!safeName(name)) throw new Error('文件名不合法');
  ensureTransferDir();
  writeFileSync(join(TRANSFER_DIR, name), content);
}

// 流式读取文件（不全部载入内存）
export function readTransferFileStream(name: string): { stream: NodeJS.ReadableStream; size: number } {
  if (!safeName(name)) throw new Error('文件名不合法');
  const filePath = join(TRANSFER_DIR, name);
  if (!existsSync(filePath)) throw new Error('文件不存在');
  const stat = statSync(filePath);
  return { stream: createReadStream(filePath), size: stat.size };
}

// 读取整个文件到内存（用于移动到实例容器）
export function readTransferFileBuffer(name: string): Buffer {
  if (!safeName(name)) throw new Error('文件名不合法');
  const filePath = join(TRANSFER_DIR, name);
  if (!existsSync(filePath)) throw new Error('文件不存在');
  return readFileSync(filePath);
}

// 删除文件
export function deleteTransferFile(name: string): void {
  if (!safeName(name)) throw new Error('文件名不合法');
  const filePath = join(TRANSFER_DIR, name);
  if (!existsSync(filePath)) throw new Error('文件不存在');
  unlinkSync(filePath);
}

// 重命名文件（补后缀）
export function renameTransferFile(oldName: string, newName: string): void {
  if (!safeName(oldName) || !safeName(newName)) throw new Error('文件名不合法');
  const oldPath = join(TRANSFER_DIR, oldName);
  const newPath = join(TRANSFER_DIR, newName);
  if (!existsSync(oldPath)) throw new Error('源文件不存在');
  if (existsSync(newPath)) throw new Error('目标文件名已存在');
  renameSync(oldPath, newPath);
}
