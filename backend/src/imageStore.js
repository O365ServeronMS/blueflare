import { access, mkdir } from 'node:fs/promises';
import path from 'node:path';

async function exists(filename) {
  try {
    await access(filename);
    return true;
  } catch {
    return false;
  }
}

export function createLocalImageStore(baseDirectory) {
  function paths(variant, hash) {
    const directory = path.join(baseDirectory, variant, hash.slice(0, 2));
    return {
      filename: path.join(directory, hash + '.webp'),
      legacyFilename: path.join(baseDirectory, variant, hash + '.webp'),
      temporary: path.join(directory, hash + '.' + process.pid + '.tmp')
    };
  }

  return {
    async find(variant, hash) {
      const target = paths(variant, hash);
      if (await exists(target.filename)) return target.filename;
      if (await exists(target.legacyFilename)) return target.legacyFilename;
      return null;
    },
    async prepareWrite(variant, hash) {
      const target = paths(variant, hash);
      await mkdir(path.dirname(target.filename), { recursive: true });
      return target;
    }
  };
}
