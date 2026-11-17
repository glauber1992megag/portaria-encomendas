import { Filesystem, Directory } from '@capacitor/filesystem';
import { Capacitor } from '@capacitor/core';

const MEMORY_KEY = 'portaria_mobile_ocr_memory_v1';
const BACKUP_FOLDER = 'Portaria Encomendas/Backup IA';
const BACKUP_FILE = 'aprendizado-ocr.json';

export function getLocalAiMemory() {
  try {
    const memory = localStorage.getItem(MEMORY_KEY);
    return memory ? JSON.parse(memory) : [];
  } catch {
    return [];
  }
}

export async function saveAiMemory(memory) {
  const normalizedMemory = Array.isArray(memory) ? memory : [];

  localStorage.setItem(
    MEMORY_KEY,
    JSON.stringify(normalizedMemory)
  );

  if (!Capacitor.isNativePlatform()) {
    return;
  }

  const backup = JSON.stringify({
    version: 1,
    updatedAt: new Date().toISOString(),
    memory: normalizedMemory,
  }, null, 2);

  await Filesystem.writeFile({
    path: `${BACKUP_FOLDER}/${BACKUP_FILE}`,
    data: backup,
    directory: Directory.Documents,
    recursive: true,
  });
}

export async function restoreAiMemory() {
  if (!Capacitor.isNativePlatform()) {
    return getLocalAiMemory();
  }

  try {
    const file = await Filesystem.readFile({
      path: `${BACKUP_FOLDER}/${BACKUP_FILE}`,
      directory: Directory.Documents,
    });

    let backup;

    if (typeof file.data === 'string') {
      backup = JSON.parse(file.data);
    } else {
      backup = JSON.parse(atob(file.data));
    }

    const memory = Array.isArray(backup.memory)
      ? backup.memory
      : [];

    localStorage.setItem(MEMORY_KEY, JSON.stringify(memory));
    return memory;
  } catch {
    return getLocalAiMemory();
  }
}
