import { useEffect, useState } from "react";
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

export function useReferenceWorklistState(params: {
  importQueueStorageKey: string;
  worklistStorageKey: string;
  legacyWorklistStorageKey: string;
}) {
  const { importQueueStorageKey, worklistStorageKey, legacyWorklistStorageKey } = params;
  const [queuedReferenceFolders, setQueuedReferenceFolders] = useState<QueuedReferenceFolder[]>(() =>
    loadStoredItems<QueuedReferenceFolder[]>(importQueueStorageKey, [])
  );
  const [referenceWorklist, setReferenceWorklist] = useState<ImportedReferenceBinding[]>(() =>
    loadStoredItems<ImportedReferenceBinding[]>(worklistStorageKey, [])
  );
  const [isWorklistImporting, setIsWorklistImporting] = useState(false);
  const [isWorklistExtracting, setIsWorklistExtracting] = useState(false);
  const [isWorklistIngesting, setIsWorklistIngesting] = useState(false);

  useEffect(() => {
    saveStoredItems(importQueueStorageKey, queuedReferenceFolders);
  }, [importQueueStorageKey, queuedReferenceFolders]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    try {
      window.localStorage.removeItem(legacyWorklistStorageKey);
    } catch {}
  }, [legacyWorklistStorageKey]);

  useEffect(() => {
    saveStoredItems(worklistStorageKey, referenceWorklist);
  }, [referenceWorklist, worklistStorageKey]);

  const appendQueuedReferenceFolders = (folders: QueuedReferenceFolder[]) => {
    if (folders.length === 0) {
      return;
    }
    setQueuedReferenceFolders((current) => {
      const existing = new Set(current.map((entry) => entry.sourceFolder));
      const next = [...current];
      for (const folder of folders) {
        if (existing.has(folder.sourceFolder)) {
          continue;
        }
        next.push(folder);
        existing.add(folder.sourceFolder);
      }
      return next;
    });
  };

  const removeQueuedReferenceFolder = (id: string) => {
    setQueuedReferenceFolders((current) => current.filter((entry) => entry.id !== id));
  };

  const updateQueuedReferenceFolderLabel = (id: string, label: string) => {
    setQueuedReferenceFolders((current) =>
      current.map((entry) => (entry.id === id ? { ...entry, label } : entry))
    );
  };

  const clearQueuedReferenceFolders = () => {
    setQueuedReferenceFolders([]);
  };

  const appendWorklistEntries = (entries: ImportedReferenceBinding[]) => {
    if (entries.length === 0) {
      return;
    }

    setReferenceWorklist((current) => {
      const next = [...current];
      const indexById = new Map(next.map((entry, index) => [entry.referenceSetId, index]));

      for (const entry of entries) {
        const existingIndex = indexById.get(entry.referenceSetId);
        if (existingIndex === undefined) {
          indexById.set(entry.referenceSetId, next.length);
          next.push(entry);
          continue;
        }

        next[existingIndex] = {
          ...next[existingIndex],
          ...entry,
        };
      }

      return next;
    });
  };

  const removeWorklistEntry = (referenceSetId: string) => {
    setReferenceWorklist((current) => current.filter((entry) => entry.referenceSetId !== referenceSetId));
  };

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
    appendQueuedReferenceFolders,
    removeQueuedReferenceFolder,
    updateQueuedReferenceFolderLabel,
    clearQueuedReferenceFolders,
    appendWorklistEntries,
    removeWorklistEntry,
  };
}
