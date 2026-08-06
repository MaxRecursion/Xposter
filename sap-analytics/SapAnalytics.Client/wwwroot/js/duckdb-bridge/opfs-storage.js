// OPFS storage helpers for snapshot files and JSON metadata.
const rootHandlePromise = navigator.storage?.getDirectory?.();

async function getDirectoryHandle(path, create = false) {
  const root = await rootHandlePromise;
  if (!root) throw new Error('OPFS is not available in this browser.');

  const parts = path.split('/').filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = await current.getDirectoryHandle(part, { create });
  }
  return current;
}

async function getParentAndName(path) {
  const parts = path.split('/').filter(Boolean);
  const fileName = parts.pop();
  if (!fileName) throw new Error(`Invalid path: ${path}`);
  const parentPath = parts.join('/');
  const parent = parentPath ? await getDirectoryHandle(parentPath, true) : await rootHandlePromise;
  return { parent, fileName };
}

export async function writeText(path, content) {
  const { parent, fileName } = await getParentAndName(path);
  const handle = await parent.getFileHandle(fileName, { create: true });
  const writable = await handle.createWritable();
  await writable.write(content);
  await writable.close();
}

export async function readText(path) {
  try {
    const { parent, fileName } = await getParentAndName(path);
    const handle = await parent.getFileHandle(fileName);
    const file = await handle.getFile();
    return await file.text();
  } catch {
    return null;
  }
}

export async function writeBytes(path, bytes) {
  const { parent, fileName } = await getParentAndName(path);
  const handle = await parent.getFileHandle(fileName, { create: true });
  const writable = await handle.createWritable();
  await writable.write(bytes);
  await writable.close();
}

export async function readBytes(path) {
  try {
    const { parent, fileName } = await getParentAndName(path);
    const handle = await parent.getFileHandle(fileName);
    const file = await handle.getFile();
    return await file.arrayBuffer();
  } catch {
    return null;
  }
}

export async function deletePath(path) {
  try {
    const { parent, fileName } = await getParentAndName(path);
    await parent.removeEntry(fileName);
  } catch {
    // ignore missing paths
  }
}

export async function deleteDirectory(path) {
  try {
    const parts = path.split('/').filter(Boolean);
    if (parts.length === 0) return;
    const dirName = parts.pop();
    const parentPath = parts.join('/');
    const parent = parentPath ? await getDirectoryHandle(parentPath, false) : await rootHandlePromise;
    await parent.removeEntry(dirName, { recursive: true });
  } catch {
    // ignore
  }
}

export async function listDirectories(path) {
  try {
    const dir = await getDirectoryHandle(path, false);
    const names = [];
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind === 'directory') names.push(name);
    }
    return names;
  } catch {
    return [];
  }
}

export async function getStorageEstimate() {
  if (!navigator.storage?.estimate) return null;
  const estimate = await navigator.storage.estimate();
  return {
    usageBytes: estimate.usage ?? 0,
    quotaBytes: estimate.quota ?? 0,
  };
}

export async function requestPersistence() {
  if (!navigator.storage?.persist) return false;
  return await navigator.storage.persist();
}
