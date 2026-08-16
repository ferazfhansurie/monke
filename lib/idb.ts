"use client";

import type { ChatMessage, ChatSession, ProjectSettings, Timeline } from "./types";

// Persists project state (not media bytes — those stay on disk, referenced
// via the FileSystemDirectoryHandle) across reloads/redeploys. Handles are
// structured-cloneable per spec, so IndexedDB can hold the actual folder
// reference — on reload we re-request permission and re-scan rather than
// re-picking the folder.

const DB_NAME = "monke";
const DB_VERSION = 1;
const STORE = "projects";
const ACTIVE_PROJECT_KEY = "monke_active_project_id";

export interface PersistedProject {
  id: string;
  name: string;
  createdAt: string;
  folderHandle: FileSystemDirectoryHandle | null;
  looseFileHandles: FileSystemFileHandle[];
  timeline: Timeline;
  settings: ProjectSettings;
  messages: ChatMessage[];
  chatHistory: ChatSession[];
  chatModel: string;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveProjectToDb(p: PersistedProject): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(p);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function deleteProjectFromDb(id: string): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function loadAllProjectsFromDb(): Promise<PersistedProject[]> {
  const db = await openDb();
  try {
    return await new Promise<PersistedProject[]>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result as PersistedProject[]);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

export function getPersistedActiveProjectId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_PROJECT_KEY);
  } catch {
    return null;
  }
}

export function setPersistedActiveProjectId(id: string): void {
  try {
    localStorage.setItem(ACTIVE_PROJECT_KEY, id);
  } catch {
    // Private browsing / storage disabled — auto-save just won't persist.
  }
}
