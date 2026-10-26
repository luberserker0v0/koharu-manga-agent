import type { ImportedReferenceSet } from "../../../api/jobs";
import type { ImportedReferenceBinding, QueuedReferenceFolder } from "../types";
import type { BindingResolution, WorklistActionParams } from "./useReferenceWorklistActions";

async function ensureImportChapter(
  entry: QueuedReferenceFolder,
  binding: BindingResolution | null,
  params: WorklistActionParams,
) {
  if (!binding?.mangaId || !binding.translatorId || binding.chapterId) return binding;
  const title = params.normalizeChapterTitleLabel(entry.label, params.folderBaseName(entry.sourceFolder));
  const chapter = await params.createChapterForBinding(binding.mangaId, binding.translatorId, title);
  return { ...binding, ...chapter };
}

async function importOne(entry: QueuedReferenceFolder, base: BindingResolution | null, params: WorklistActionParams) {
  const binding = await ensureImportChapter(entry, base, params);
  params.setPageStatus(`正在匯入 ${entry.label}...`);
  const language = params.normalizeReferenceLanguage(params.importForm.language);
  const upload = await params.uploadImageFolderFn({ sourceFolder: entry.sourceFolder, kind: "reference" });
  const result = await params.importReferenceFolderFn({
    uploadId: upload.uploadId,
    label: entry.label.trim() || params.folderBaseName(entry.sourceFolder),
    language,
    referenceKind: params.importForm.referenceKind,
    ...binding,
  });
  const importedBinding: ImportedReferenceBinding = {
    referenceSetId: result.referenceSet.id,
    label: result.referenceSet.label,
    referenceKind: result.referenceSet.referenceKind || params.importForm.referenceKind,
    language,
    ...binding,
  };
  return { referenceSet: result.referenceSet, binding: importedBinding };
}

async function finishImport(
  sets: ImportedReferenceSet[],
  bindings: ImportedReferenceBinding[],
  params: WorklistActionParams,
) {
  const first = sets[0];
  if (first) {
    params.setExtractionForm((current) => ({ ...current, referenceSetId: first.id }));
    params.setIngestionForm((current) => ({ ...current, referenceSetId: first.id }));
  }
  params.clearQueuedReferenceFolders();
  params.appendWorklistEntries(bindings);
  params.setImportForm((current) => ({ ...current, sourceFolder: "", label: "" }));
  params.setPageStatus(`已匯入 ${sets.length} 筆 Reference。`);
  await Promise.all([
    params.queryClient.invalidateQueries({ queryKey: ["referenceSets"] }),
    params.queryClient.invalidateQueries({ queryKey: ["mangaSeries"] }),
  ]);
}

export async function importQueuedReferenceFolders(params: WorklistActionParams) {
  if (!params.queuedReferenceFolders.length) {
    params.setPageStatus("請先載入至少一筆 Reference 資料夾。");
    return;
  }
  params.setIsWorklistImporting(true);
  try {
    const base = params.importForm.mangaSelection ? await params.resolveImportBinding() : null;
    if (params.importForm.mangaSelection && !base) return params.setPageStatus("請先完成漫畫與譯者綁定。");
    const imported = [];
    for (const entry of params.queuedReferenceFolders) imported.push(await importOne(entry, base, params));
    await finishImport(
      imported.map((item) => item.referenceSet),
      imported.map((item) => item.binding),
      params,
    );
  } catch (error) {
    params.setPageStatus(error instanceof Error ? error.message : "匯入 Reference 失敗。");
  } finally {
    params.setIsWorklistImporting(false);
  }
}
