import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import type { ImportedReferenceBinding, QueuedReferenceFolder } from "../types";

function loadStoredItems<T>(storageKey: string, fallback: T): T {
  if (typeof window === "undefined") {
    return fallback;
  }

  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) {
      return fallback;
    }
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function saveStoredItems(storageKey: string, value: unknown) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(storageKey, JSON.stringify(value));
  } catch {}
}

function useStoredState<T>(storageKey: string, fallback: T) {
  const [value, setValue] = useState<T>(() => loadStoredItems(storageKey, fallback));
  useEffect(() => saveStoredItems(storageKey, value), [storageKey, value]);
  return [value, setValue] as const;
}

function useLegacyCleanup(storageKey: string) {
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.removeItem(storageKey);
    } catch {}
  }, [storageKey]);
}

function mergeQueuedFolders(current: QueuedReferenceFolder[], folders: QueuedReferenceFolder[]) {
  const existing = new Set(current.map((entry) => entry.sourceFolder));
  return [
    ...current,
    ...folders.filter((folder) => {
      if (existing.has(folder.sourceFolder)) return false;
      existing.add(folder.sourceFolder);
      return true;
    }),
  ];
}

function mergeWorklistEntries(current: ImportedReferenceBinding[], entries: ImportedReferenceBinding[]) {
  const next = [...current];
  const indexById = new Map(next.map((entry, index) => [entry.referenceSetId, index]));
  for (const entry of entries) {
    const existingIndex = indexById.get(entry.referenceSetId);
    if (existingIndex === undefined) {
      indexById.set(entry.referenceSetId, next.length);
      next.push(entry);
    } else {
      next[existingIndex] = { ...next[existingIndex], ...entry };
    }
  }
  return next;
}

function worklistActions(
  setQueued: Dispatch<SetStateAction<QueuedReferenceFolder[]>>,
  setWorklist: Dispatch<SetStateAction<ImportedReferenceBinding[]>>,
) {
  return {
    appendQueuedReferenceFolders: (folders: QueuedReferenceFolder[]) => {
      if (folders.length) setQueued((current) => mergeQueuedFolders(current, folders));
    },
    removeQueuedReferenceFolder: (id: string) => setQueued((current) => current.filter((entry) => entry.id !== id)),
    updateQueuedReferenceFolderLabel: (id: string, label: string) =>
      setQueued((current) => current.map((entry) => (entry.id === id ? { ...entry, label } : entry))),
    clearQueuedReferenceFolders: () => setQueued([]),
    appendWorklistEntries: (entries: ImportedReferenceBinding[]) => {
      if (entries.length) setWorklist((current) => mergeWorklistEntries(current, entries));
    },
    removeWorklistEntry: (id: string) =>
      setWorklist((current) => current.filter((entry) => entry.referenceSetId !== id)),
  };
}

export function useReferenceWorklistState(params: {
  importQueueStorageKey: string;
  worklistStorageKey: string;
  legacyWorklistStorageKey: string;
}) {
  const { importQueueStorageKey, worklistStorageKey, legacyWorklistStorageKey } = params;
  const [queuedReferenceFolders, setQueuedReferenceFolders] = useStoredState<QueuedReferenceFolder[]>(
    importQueueStorageKey,
    [],
  );
  const [referenceWorklist, setReferenceWorklist] = useStoredState<ImportedReferenceBinding[]>(worklistStorageKey, []);
  const [isWorklistImporting, setIsWorklistImporting] = useState(false);
  const [isWorklistExtracting, setIsWorklistExtracting] = useState(false);
  const [isWorklistIngesting, setIsWorklistIngesting] = useState(false);
  useLegacyCleanup(legacyWorklistStorageKey);
  const actions = worklistActions(setQueuedReferenceFolders, setReferenceWorklist);
  return {
    queuedReferenceFolders,
    setQueuedReferenceFolders,
    referenceWorklist,
    setReferenceWorklist,
    isWorklistImporting,
    setIsWorklistImporting,
    isWorklistExtracting,
    setIsWorklistExtracting,
    isWorklistIngesting,
    setIsWorklistIngesting,
    ...actions,
  };
}
