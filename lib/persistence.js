const fs = require('node:fs');
const path = require('node:path');

const writes = new Map();

function serialize(filePath, task) {
  const previous = writes.get(filePath) || Promise.resolve();
  const current = previous.catch(() => {}).then(task);
  const tracked = current.finally(() => {
    if (writes.get(filePath) === tracked) writes.delete(filePath);
  });
  writes.set(filePath, tracked);
  return tracked;
}

async function atomicWriteJson(filePath, value) {
  return serialize(filePath, async () => {
    await fs.promises.mkdir(path.dirname(filePath), {recursive:true});
    const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    const backup = `${filePath}.bak`;
    await fs.promises.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    try {
      await readJson(filePath);
      await fs.promises.copyFile(filePath, backup);
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    await fs.promises.rename(temporary, filePath);
    return value;
  });
}

async function readJson(filePath) {
  return JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
}

async function readJsonWithBackup(filePath, fallback = null) {
  try {
    return {value:await readJson(filePath), recoveredFromBackup:false};
  } catch (primaryError) {
    try {
      return {value:await readJson(`${filePath}.bak`), recoveredFromBackup:true, primaryError:primaryError.message};
    } catch {
      return {value:fallback, recoveredFromBackup:false, primaryError:primaryError.message};
    }
  }
}

class ResearchJobStore {
  constructor(root) {
    this.root = root;
  }

  manifest(jobId) {
    return path.join(this.root, jobId, 'manifest.json');
  }

  results(jobId) {
    return path.join(this.root, jobId, 'results.json');
  }

  async start(input) {
    const now = new Date().toISOString();
    const manifest = {...input, state:'running', cursor:0, completed:0, valid:0, failed:0, createdAt:now, updatedAt:now};
    await atomicWriteJson(this.results(input.jobId), []);
    await atomicWriteJson(this.manifest(input.jobId), manifest);
    return manifest;
  }

  async status(jobId) {
    return (await readJsonWithBackup(this.manifest(jobId), null)).value;
  }

  async readResults(jobId) {
    return (await readJsonWithBackup(this.results(jobId), [])).value || [];
  }

  async recordBatch(jobId, rows) {
    const current = (await readJsonWithBackup(this.results(jobId), [])).value || [];
    const byCode = new Map(current.map(item => [String(item.code), item]));
    for (const row of rows || []) if (row?.code) byCode.set(String(row.code), row);
    const results = [...byCode.values()];
    await atomicWriteJson(this.results(jobId), results);
    const manifest = await this.status(jobId);
    const valid = results.filter(item => item?.factor && !item?.error).length;
    const failed = results.filter(item => item?.error || !item?.factor).length;
    const next = {...manifest, cursor:results.length, completed:results.length, valid, failed, updatedAt:new Date().toISOString()};
    await atomicWriteJson(this.manifest(jobId), next);
    return next;
  }

  async cancel(jobId) {
    return this.setState(jobId, 'cancelled');
  }

  async resume(jobId) {
    return this.setState(jobId, 'running');
  }

  async complete(jobId) {
    return this.setState(jobId, 'completed');
  }

  async setState(jobId, state) {
    const manifest = await this.status(jobId);
    if (!manifest) throw new Error(`任务不存在：${jobId}`);
    const next = {...manifest, state, updatedAt:new Date().toISOString()};
    await atomicWriteJson(this.manifest(jobId), next);
    return next;
  }
}

module.exports = {atomicWriteJson, readJsonWithBackup, ResearchJobStore};
