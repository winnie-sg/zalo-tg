import { readFileSync } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { Magika } from 'magika';
import { config } from '../config.js';

let _magikaInstance: Magika | null = null;
let _magikaLoadingPromise: Promise<Magika> | null = null;

/**
 * Get or lazily initialize the singleton Magika model instance.
 */
export async function getMagika(): Promise<Magika> {
  if (_magikaInstance) return _magikaInstance;
  if (!_magikaLoadingPromise) {
    _magikaLoadingPromise = (async () => {
      const m = await Magika.create();
      _magikaInstance = m;
      return m;
    })();
  }
  return _magikaLoadingPromise;
}

export type FileSecurityStatus = 'safe' | 'suspicious' | 'low_confidence_mismatch';

export interface FileSecurityResult {
  safe: boolean;
  status: FileSecurityStatus;
  requiresApproval: boolean;
  forceDocFallback: boolean;
  reason?: string;
  detectedType?: string;
  declaredType?: string;
  confidence?: number;
  sha256?: string;
}

export interface PendingSecurityAction {
  id: string;
  direction: 'tg_to_zalo' | 'zalo_to_tg';
  filename: string;
  localPath: string;
  topicId: number;
  zaloId?: string;
  threadType?: number;
  secCheck: FileSecurityResult;
  expiresAt: number;
  executeApprove: () => Promise<void>;
  executeDeny?: () => Promise<void>;
}

class PendingSecurityStore {
  private actions = new Map<string, PendingSecurityAction>();
  private sweepInterval: NodeJS.Timeout | null = null;

  constructor() {
    this.sweepInterval = setInterval(() => this.sweep(), 60_000);
    this.sweepInterval.unref?.();
  }

  add(action: Omit<PendingSecurityAction, 'id' | 'expiresAt'>): PendingSecurityAction {
    const id = crypto.randomBytes(8).toString('hex');
    const fullAction: PendingSecurityAction = {
      ...action,
      id,
      expiresAt: Date.now() + 10 * 60_000, // 10 minutes TTL
    };
    this.actions.set(id, fullAction);
    return fullAction;
  }

  get(id: string): PendingSecurityAction | undefined {
    const act = this.actions.get(id);
    if (!act) return undefined;
    if (act.expiresAt < Date.now()) {
      this.remove(id);
      return undefined;
    }
    return act;
  }

  remove(id: string): boolean {
    const act = this.actions.get(id);
    if (!act) return false;
    this.actions.delete(id);
    return true;
  }

  private async sweep() {
    const now = Date.now();
    for (const [id, act] of this.actions.entries()) {
      if (act.expiresAt < now) {
        this.actions.delete(id);
        try {
          if (act.executeDeny) {
            await act.executeDeny().catch(() => {});
          } else if (act.localPath) {
            const { cleanTemp } = await import('./media.js');
            await cleanTemp(act.localPath).catch(() => {});
          }
        } catch { /* ignore */ }
      }
    }
  }
}

export const pendingSecurityStore = new PendingSecurityStore();

// Semantic category mappings for file extensions and Magika output labels
const EXTENSION_CATEGORIES: Record<string, string> = {
  // Images
  jpg: 'image', jpeg: 'image', png: 'image', gif: 'image', webp: 'image',
  bmp: 'image', ico: 'image', tiff: 'image', svg: 'image', heic: 'image',
  avif: 'image', jp2: 'image', psd: 'image', icns: 'image', cur: 'image',

  // Videos
  mp4: 'video', mkv: 'video', avi: 'video', mov: 'video', webm: 'video',
  flv: 'video', '3gp': 'video', wmv: 'video', m4v: 'video', mts: 'video',
  mpg: 'video', mpeg: 'video',

  // Audios
  mp3: 'audio', wav: 'audio', m4a: 'audio', ogg: 'audio', flac: 'audio',
  aac: 'audio', wma: 'audio', opus: 'audio', midi: 'audio', m4r: 'audio',
  oga: 'audio', mid: 'audio',

  // Documents
  pdf: 'document', doc: 'document', docx: 'document', xls: 'document',
  xlsx: 'document', ppt: 'document', pptx: 'document', odt: 'document',
  ods: 'document', odp: 'document', rtf: 'document', epub: 'document',

  // Executables and scripts
  exe: 'executable', dll: 'executable', so: 'executable', dylib: 'executable',
  bat: 'executable', cmd: 'executable', ps1: 'executable', sh: 'executable',
  bash: 'executable', vbs: 'executable', vbe: 'executable', js: 'executable_script',
  msi: 'executable', apk: 'executable', jar: 'executable', bin: 'executable',
  py: 'executable_script', php: 'executable_script', rb: 'executable_script',

  // Archives
  zip: 'archive', rar: 'archive', '7z': 'archive', tar: 'archive',
  gz: 'archive', bz2: 'archive', xz: 'archive', iso: 'archive',

  // Text / Code
  txt: 'text', json: 'text', xml: 'text', html: 'text', htm: 'text',
  css: 'text', ts: 'text', md: 'text', csv: 'text', env: 'text',
  yaml: 'text', yml: 'text', ini: 'text', log: 'text', sql: 'text',
};

const MAGIKA_LABEL_CATEGORIES: Record<string, string> = {
  // Images
  jpeg: 'image', png: 'image', gif: 'image', webp: 'image', bmp: 'image',
  ico: 'image', tiff: 'image', svg: 'image', heic: 'image', avif: 'image',

  // Videos
  mp4: 'video', mkv: 'video', avi: 'video', mov: 'video', webm: 'video',
  flv: 'video', '3gp': 'video', wmv: 'video', m4v: 'video', mpeg: 'video',

  // Audios
  mp3: 'audio', wav: 'audio', m4a: 'audio', ogg: 'audio', flac: 'audio',
  aac: 'audio', opus: 'audio', midi: 'audio',

  // Documents
  pdf: 'document', doc: 'document', docx: 'document', xls: 'document',
  xlsx: 'document', ppt: 'document', pptx: 'document', odt: 'document',
  ods: 'document', odp: 'document', rtf: 'document', epub: 'document',

  // Executables / Binaries / Scripts
  pebin: 'executable', elf: 'executable', macho: 'executable', dex: 'executable',
  batch: 'executable', powershell: 'executable', shell: 'executable',
  vba: 'executable', autohotkey: 'executable', java: 'executable_script',
  javascript: 'executable_script', python: 'executable_script', php: 'executable_script',
  ruby: 'executable_script',

  // Archives
  zip: 'archive', rar: 'archive', '7z': 'archive', tar: 'archive',
  gzip: 'archive', bzip2: 'archive', xz: 'archive', iso: 'archive',

  // Text
  txt: 'text', json: 'text', xml: 'text', html: 'text', css: 'text',
  csv: 'text', markdown: 'text', yaml: 'text', ini: 'text', sql: 'text',
};

// Known benign container pairings (e.g. docx internally uses zip format)
const COMPATIBLE_PAIRS = new Set([
  'docx:zip', 'xlsx:zip', 'pptx:zip', 'apk:zip', 'jar:zip',
  'm4a:mp4', 'm4v:mp4', 'aac:mp4', 'mp3:mp4', 'ogg:opus',
  'json:txt', 'csv:txt', 'md:txt', 'ts:txt', 'js:txt', 'py:txt',
  'env:txt', 'log:txt', 'sql:txt', 'ini:txt', 'yaml:txt', 'yml:txt',
  'jpg:jpeg', 'jpeg:jpeg', 'htm:html', 'html:html',
]);

export function calculateSha256(data: Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Inspect file buffer against declared metadata using Google Magika.
 */
export async function inspectFileSecurity(
  filePath: string,
  declaredFileName: string,
  declaredMime?: string,
): Promise<FileSecurityResult> {
  const safeDefault: FileSecurityResult = {
    safe: true,
    status: 'safe',
    requiresApproval: false,
    forceDocFallback: false,
  };

  if (!config.security.magikaBlockDisguised) {
    return safeDefault;
  }

  let buffer: Buffer;
  try {
    buffer = readFileSync(filePath);
  } catch (readErr) {
    console.warn(`[FileSecurity] Could not read file for inspection (${filePath}):`, readErr);
    return safeDefault;
  }

  if (buffer.length === 0) {
    return safeDefault;
  }

  const sha256 = calculateSha256(buffer);
  const ext = path.extname(declaredFileName).replace(/^\./, '').toLowerCase();

  try {
    const magika = await getMagika();
    const result = await magika.identifyBytes(buffer);
    const label = result.prediction.output.label.toLowerCase();
    const score = Number(result.prediction.score ?? 0);

    const declaredCategory = EXTENSION_CATEGORIES[ext] || (declaredMime ? declaredMime.split('/')[0] : 'unknown');
    const detectedCategory = MAGIKA_LABEL_CATEGORIES[label] || (result.prediction.output.is_text ? 'text' : 'unknown');

    const threshold = config.security.magikaConfidenceThreshold;

    // Check if directly identical (e.g. ext="pdf" and label="pdf", ext="jpg" and label="jpeg")
    if (ext === label || (ext === 'jpg' && label === 'jpeg') || (ext === 'jpeg' && label === 'jpeg')) {
      return {
        safe: true,
        status: 'safe',
        requiresApproval: false,
        forceDocFallback: false,
        detectedType: label,
        declaredType: ext,
        confidence: score,
        sha256,
      };
    }

    // Check compatible known container pairings
    if (COMPATIBLE_PAIRS.has(`${ext}:${label}`)) {
      return {
        safe: true,
        status: 'safe',
        requiresApproval: false,
        forceDocFallback: false,
        detectedType: label,
        declaredType: ext,
        confidence: score,
        sha256,
      };
    }

    // Low confidence prediction (< threshold)
    if (score < threshold) {
      console.warn(
        `[SECURITY] Low confidence (${(score * 100).toFixed(1)}% < ${(threshold * 100).toFixed(1)}%) for "${declaredFileName}" (${ext}): detected "${label}" (SHA-256: ${sha256})`,
      );

      // If declared as media (image, video, audio) but detected as text/script/etc., flag for approval and document fallback
      const isMediaMismatch = ['image', 'video', 'audio'].includes(declaredCategory) && detectedCategory !== declaredCategory;

      return {
        safe: false,
        status: 'low_confidence_mismatch',
        requiresApproval: true,
        forceDocFallback: isMediaMismatch,
        reason: `Độ tin cậy nhận diện thấp (${(score * 100).toFixed(1)}% < ${(threshold * 100).toFixed(1)}%): Phát hiện "${label}" thay vì định dạng khai báo ".${ext}"`,
        detectedType: label,
        declaredType: ext || declaredMime || 'unknown',
        confidence: score,
        sha256,
      };
    }

    // High confidence mismatch (>= threshold)
    // DISGUISE CHECK 1: Dangerous executable/script disguised as media or document
    if (detectedCategory === 'executable' || detectedCategory === 'executable_script') {
      if (['image', 'video', 'audio', 'document'].includes(declaredCategory)) {
        return {
          safe: false,
          status: 'suspicious',
          requiresApproval: true,
          forceDocFallback: true,
          reason: `Tệp mã thực thi/kịch bản (${label}) ngụy trang dưới định dạng ${declaredCategory} (.${ext})`,
          detectedType: label,
          declaredType: ext || declaredMime || 'unknown',
          confidence: score,
          sha256,
        };
      }
    }

    // DISGUISE CHECK 2: Archive / polyglot disguised as media
    if (detectedCategory === 'archive' && ['image', 'audio', 'video'].includes(declaredCategory)) {
      return {
        safe: false,
        status: 'suspicious',
        requiresApproval: true,
        forceDocFallback: true,
        reason: `Tệp nén/archive (${label}) ngụy trang dưới định dạng ${declaredCategory} (.${ext})`,
        detectedType: label,
        declaredType: ext || declaredMime || 'unknown',
        confidence: score,
        sha256,
      };
    }

    // DISGUISE CHECK 3: Media family mismatch
    if (declaredCategory === 'image' && !['image', 'unknown'].includes(detectedCategory)) {
      return {
        safe: false,
        status: 'suspicious',
        requiresApproval: true,
        forceDocFallback: true,
        reason: `Nội dung không phải hình ảnh (${label}, ${detectedCategory}) ngụy trang thành hình ảnh (.${ext})`,
        detectedType: label,
        declaredType: ext || declaredMime || 'unknown',
        confidence: score,
        sha256,
      };
    }

    if (declaredCategory === 'audio' && !['audio', 'video', 'unknown'].includes(detectedCategory)) {
      return {
        safe: false,
        status: 'suspicious',
        requiresApproval: true,
        forceDocFallback: true,
        reason: `Nội dung không phải âm thanh (${label}, ${detectedCategory}) ngụy trang thành âm thanh (.${ext})`,
        detectedType: label,
        declaredType: ext || declaredMime || 'unknown',
        confidence: score,
        sha256,
      };
    }

    if (declaredCategory === 'video' && !['video', 'unknown'].includes(detectedCategory)) {
      return {
        safe: false,
        status: 'suspicious',
        requiresApproval: true,
        forceDocFallback: true,
        reason: `Nội dung không phải video (${label}, ${detectedCategory}) ngụy trang thành video (.${ext})`,
        detectedType: label,
        declaredType: ext || declaredMime || 'unknown',
        confidence: score,
        sha256,
      };
    }

    if (declaredCategory === 'document' && ['executable', 'archive'].includes(detectedCategory) && !COMPATIBLE_PAIRS.has(`${ext}:${label}`)) {
      return {
        safe: false,
        status: 'suspicious',
        requiresApproval: true,
        forceDocFallback: true,
        reason: `Tệp giả mạo (${label}) ngụy trang thành tài liệu (.${ext})`,
        detectedType: label,
        declaredType: ext || declaredMime || 'unknown',
        confidence: score,
        sha256,
      };
    }

    // Text & generic text-based code variants are safe
    if (declaredCategory === 'text' && (detectedCategory === 'text' || result.prediction.output.is_text)) {
      return {
        safe: true,
        status: 'safe',
        requiresApproval: false,
        forceDocFallback: false,
        detectedType: label,
        declaredType: ext,
        confidence: score,
        sha256,
      };
    }

    return {
      safe: true,
      status: 'safe',
      requiresApproval: false,
      forceDocFallback: false,
      detectedType: label,
      declaredType: ext || declaredMime || 'unknown',
      confidence: score,
      sha256,
    };
  } catch (err) {
    console.warn(`[FileSecurity] Inspection error on file ${declaredFileName}:`, err);
    return safeDefault;
  }
}
