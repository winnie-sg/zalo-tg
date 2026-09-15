import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

type Entry = { timestamp: Date; level: string; message: string };
const args: Record<string, string> = {};
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (!['--from', '--to', '--log-dir', '--output'].includes(key) || !value) throw new Error('Usage: npm run logs:merge -- --from <ISO time> --to <ISO time> [--log-dir <dir>] [--output <file>]');
  args[key] = value;
}
const parse = (value: string, label: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${label} must be ISO-8601, e.g. 2026-07-31T09:00:00+07:00`);
  return date;
};
async function main() {
  if (!args['--from'] || !args['--to']) throw new Error('Both --from and --to are required');
  const from = parse(args['--from'], '--from'), to = parse(args['--to'], '--to');
  if (from > to) throw new Error('--from must not be after --to');
  const root = path.resolve(args['--log-dir'] || process.env.LOG_DIR?.trim() || 'logs');
  let folders: string[]; try { folders = await readdir(root); } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') folders = []; else throw error; }
  const entries: Entry[] = [];
  for (const folder of folders.filter((name) => /^\d{2}-\d{2}-\d{4}$/.test(name))) {
    let files: string[]; try { files = await readdir(path.join(root, folder)); } catch { continue; }
    for (const file of files.filter((name) => /^(debug|info|warn|error)\.log$/.test(name))) {
      const level = path.basename(file, '.log').toUpperCase();
      const text = await readFile(path.join(root, folder, file), 'utf8');
      for (const line of text.split(/\r?\n/)) {
        const match = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s?(.*)$/); if (!match) continue;
        const timestamp = new Date(match[1]); if (timestamp >= from && timestamp <= to) entries.push({ timestamp, level, message: match[2] });
      }
    }
  }
  const output = entries.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime() || a.level.localeCompare(b.level)).map((item) => `${item.timestamp.toISOString()} [${item.level}] ${item.message}\n`).join('');
  if (!args['--output']) return void process.stdout.write(output || 'No log entries found in the requested time range.\n');
  const target = path.resolve(args['--output']); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, output, 'utf8');
  process.stdout.write(`Merged ${entries.length} entries into ${target}\n`);
}
main().catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });