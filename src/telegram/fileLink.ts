import path from 'path';
import { pathToFileURL } from 'url';

type TelegramFileApi = {
  getFile(fileId: string): Promise<{ file_path?: string }>;
  getFileLink(fileId: string): Promise<URL>;
};

/**
 * Resolve a Telegram file for download by the bridge.
 *
 * Official Bot API mode returns an HTTPS URL via Telegraf's getFileLink().
 * Local Bot API mode (--local) returns an absolute filesystem path from
 * getFile(); convert that path into a hostless file:// URL so Node can safely
 * consume it on Linux. This avoids invalid URLs such as
 * file://telegram-bot-api/tmp/..., whose hostname Node rejects.
 */
export async function resolveTelegramFileLink(
  telegram: TelegramFileApi,
  fileId: string,
  localServer: string | null,
): Promise<URL> {
  if (!localServer) {
    return telegram.getFileLink(fileId);
  }

  const file = await telegram.getFile(fileId);
  const filePath = file.file_path;
  if (!filePath) {
    throw new Error('Local Telegram Bot API returned no file_path');
  }
  if (!path.isAbsolute(filePath)) {
    throw new Error(`Local Telegram Bot API returned a non-absolute file_path: ${filePath}`);
  }

  return pathToFileURL(filePath);
}
