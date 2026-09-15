import path from 'path';
import { fileURLToPath } from 'url';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
