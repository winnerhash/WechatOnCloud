// 互传：宿主机文件中转。面板通过挂载卷读写宿主机 /home/rogerwi/uploads 目录，
// iOS 快捷指令等外部工具可直接往该目录推送文件，面板内浏览/上传/下载/删除。

import { readdirSync, statSync, unlinkSync, existsSync, mkdirSync, writeFileSync, createReadStream } from 'node:fs';
import { join } from 'node:path';
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

// 删除文件
export function deleteTransferFile(name: string): void {
  if (!safeName(name)) throw new Error('文件名不合法');
  const filePath = join(TRANSFER_DIR, name);
  if (!existsSync(filePath)) throw new Error('文件不存在');
  unlinkSync(filePath);
}
