import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function loadPrompt(filename: string): string {
  const path = join(__dirname, '..', '..', 'prompts', filename);
  return readFileSync(path, 'utf-8');
}

export function loadStrategy(filename: string): string {
  const path = join(__dirname, '..', '..', 'memory', filename);
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return `Strategy file ${filename} not found.`;
  }
}
