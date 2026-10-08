import { mkdir, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Process-local state only; a fresh server starts with an empty arena. */
export class MemoryStore {
  constructor() { this.value = { schema: 1, sessions: {}, rooms: {}, tournaments: {} }; }
  async read() { return structuredClone(this.value); }
  async write(value) { this.value = structuredClone(value); }
}

/** One serialized service owns this file. Replace only after a complete fsynced write. */
export class AtomicStore {
  constructor(path) { this.path = path; }
  async read() {
    try {
      const value = JSON.parse(await readFile(this.path, 'utf8'));
      if (value.schema !== 1 || !value.sessions || !value.rooms) throw new Error('Unsupported online duel store.');
      return value;
    } catch (error) {
      if (error.code === 'ENOENT') return { schema: 1, sessions: {}, rooms: {} };
      throw error;
    }
  }
  async write(value) {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    // fsync the contents before rename; acknowledged requests survive process restart.
    const { open } = await import('node:fs/promises');
    try {
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
      await rename(temporary, this.path);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }
}
