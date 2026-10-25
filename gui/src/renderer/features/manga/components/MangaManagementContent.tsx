import type { DragEvent } from "react";
import type { ChapterSummary, MangaSeriesSummary } from "../../../api/jobs";
import { moveChapterId, type MangaManagementModel, useMangaManagementModel } from "../hooks/useMangaManagementModel";

function MangaListItem({ model, series }: { model: MangaManagementModel; series: MangaSeriesSummary }) {
  return <li className="artifact-item"><div><strong>{series.label}</strong>
    <div className="job-subtext">{series.mangaId}</div><div className="job-subtext">
      {model.t("manga.list.translatorProfiles", { language: series.language, count: series.translators.length })}
    </div></div><div className="job-actions">
      <button className="secondary-button" type="button"
        onClick={() => model.selectManga(series.mangaId)}>{model.t("manga.list.select")}</button>
      <button className="secondary-button danger-button" type="button"
        disabled={model.deleteMangaMutation.isPending} onClick={() => void model.confirmDeleteManga(series)}>
        {model.t("manga.list.delete")}</button>
    </div>
  </li>;
}

function MangaListCard({ model }: { model: MangaManagementModel }) {
  return <article className="card"><h2>{model.t("manga.list.title")}</h2>
    {model.mangaQuery.isLoading ? <p>{model.t("manga.list.loading")}</p> : null}
    {!model.mangaQuery.isLoading ? <ul className="artifact-list">
      {(model.mangaQuery.data?.series || []).map((series) =>
        <MangaListItem model={model} series={series} key={series.mangaId} />)}
    </ul> : null}
  </article>;
}

type Translator = MangaSeriesSummary["translators"][number];

function TranslatorListItem({ model, translator }: { model: MangaManagementModel; translator: Translator }) {
  return <li className="artifact-item"><div><strong>{translator.label}</strong>
    <div className="job-subtext">{translator.translatorId}</div><div className="job-subtext">
      {model.t("manga.translatorList.chapters", { language: translator.language, count: translator.chapterCount })}
    </div></div><div className="job-actions">
      <button className="secondary-button" type="button"
        onClick={() => model.selectTranslator(translator.translatorId)}>{model.t("manga.list.select")}</button>
      <button className="secondary-button danger-button" type="button"
        disabled={model.deleteTranslatorMutation.isPending}
        onClick={() => void model.confirmDeleteTranslator(translator)}>{model.t("manga.list.delete")}</button>
    </div>
  </li>;
}

function TranslatorListCard({ model }: { model: MangaManagementModel }) {
  return <article className="card"><h2>{model.t("manga.translatorList.title")}</h2>
    {!model.selectedManga ? <p>{model.t("manga.translatorList.empty")}</p> : null}
    {model.selectedManga ? <ul className="artifact-list">{model.translatorOptions.map((translator) =>
      <TranslatorListItem model={model} translator={translator} key={translator.translatorId} />)}</ul> : null}
  </article>;
}

function MangaSelector({ model }: { model: MangaManagementModel }) {
  return <label><span>{model.t("manga.chapterManagement.manga")}</span>
    <select value={model.selectedMangaId} onChange={(event) => model.selectManga(event.currentTarget.value)}>
      <option value="">{model.t("manga.chapterManagement.selectManga")}</option>
      {(model.mangaQuery.data?.series || []).map((series) =>
        <option key={series.mangaId} value={series.mangaId}>{series.label} ({series.mangaId})</option>)}
    </select>
  </label>;
}

function TranslatorSelector({ model }: { model: MangaManagementModel }) {
  const placeholder = model.selectedMangaId
    ? model.t("manga.chapterManagement.selectTranslator") : model.t("manga.chapterManagement.chooseMangaFirst");
  return <label><span>{model.t("manga.chapterManagement.translator")}</span>
    <select value={model.selectedTranslatorId} onChange={(event) => model.selectTranslator(event.currentTarget.value)}
      disabled={!model.selectedMangaId}><option value="">{placeholder}</option>
      {model.translatorOptions.map((translator) => <option key={translator.translatorId}
        value={translator.translatorId}>{translator.label} ({translator.translatorId})</option>)}
    </select>
  </label>;
}

function ChapterSelectionCard({ model }: { model: MangaManagementModel }) {
  return <article className="card"><h2>{model.t("manga.chapterManagement.title")}</h2>
    <div className="form-grid"><MangaSelector model={model} /><TranslatorSelector model={model} /></div>
  </article>;
}

function AddChapterCard({ model }: { model: MangaManagementModel }) {
  const disabled = !model.selectedMangaId || !model.selectedTranslatorId ||
    !model.newChapterTitle.trim() || model.createChapterMutation.isPending;
  return <article className="card"><h2>{model.t("manga.addChapter.title")}</h2>
    <div className="inline-field-row"><input placeholder={model.t("manga.addChapter.placeholder")}
      value={model.newChapterTitle} onChange={(event) => model.setNewChapterTitle(event.currentTarget.value)} />
      <button className="primary-button" type="button" disabled={disabled}
        onClick={() => model.createChapterMutation.mutate()}>{model.t("manga.addChapter.create")}</button>
    </div>
  </article>;
}

function reorderDuringDrag(model: MangaManagementModel, chapterId: string, event: DragEvent<HTMLLIElement>) {
  event.preventDefault();
  if (!model.draggedChapterId || model.draggedChapterId === chapterId) return;
  model.setOrderedChapterIds((current) => moveChapterId(current.length
    ? current : model.chapters.map((entry) => entry.chapterId), model.draggedChapterId as string, chapterId));
}

function editChapterTitle(model: MangaManagementModel, chapter: ChapterSummary) {
  const nextTitle = window.prompt(model.t("manga.prompt.chapterTitle"), chapter.chapterTitle || "");
  if (nextTitle == null) return;
  model.updateChapterMutation.mutate({ chapterId: chapter.chapterId, chapterTitle: nextTitle.trim() || null });
}

function ChapterRow({ model, chapter, index }: {
  model: MangaManagementModel; chapter: ChapterSummary; index: number;
}) {
  const dragging = model.draggedChapterId === chapter.chapterId;
  return <li className={dragging ? "preflight-image-card dragging" : "preflight-image-card"} draggable
    onDragStart={() => model.setDraggedChapterId(chapter.chapterId)}
    onDragOver={(event) => reorderDuringDrag(model, chapter.chapterId, event)}
    onDrop={() => model.setDraggedChapterId(null)} onDragEnd={() => model.setDraggedChapterId(null)}>
    <div className="preflight-image-order">{index + 1}</div>
    <div className="preflight-image-meta"><strong>{chapter.chapterTitle || chapter.chapterId}</strong>
      <span>{chapter.chapterId}</span></div>
    <div className="job-actions"><button className="secondary-button" type="button"
      onClick={() => editChapterTitle(model, chapter)}>{model.t("manga.order.editTitle")}</button>
      <button className="secondary-button danger-button" type="button"
        disabled={model.deleteChapterMutation.isPending} onClick={() => void model.confirmDeleteChapter(chapter)}>
        {model.t("manga.list.delete")}</button>
    </div>
  </li>;
}

function SaveOrderButton({ model }: { model: MangaManagementModel }) {
  const unchanged = model.effectiveOrderedChapterIds.join("|") === model.chapters.map((entry) => entry.chapterId).join("|");
  const disabled = !model.selectedMangaId || !model.selectedTranslatorId || model.reorderMutation.isPending || unchanged;
  return <div className="button-row"><button className="primary-button" type="button" disabled={disabled}
    onClick={() => model.reorderMutation.mutate()}>{model.t("manga.order.save")}</button></div>;
}

function ChapterOrderContent({ model }: { model: MangaManagementModel }) {
  if (!model.selectedMangaId || !model.selectedTranslatorId) return <p>{model.t("manga.order.emptySelection")}</p>;
  if (model.chaptersQuery.isLoading) return <p>{model.t("manga.order.loading")}</p>;
  if (!model.displayedChapters.length) return <p>{model.t("manga.order.none")}</p>;
  return <><ul className="preflight-image-list">{model.displayedChapters.map((chapter, index) =>
    <ChapterRow model={model} chapter={chapter} index={index} key={chapter.chapterId} />)}</ul>
    <SaveOrderButton model={model} />
  </>;
}

function ChapterOrderCard({ model }: { model: MangaManagementModel }) {
  return <article className="card"><h2>{model.t("manga.order.title")}</h2>
    <ChapterOrderContent model={model} />
  </article>;
}

export function MangaManagementContent() {
  const model = useMangaManagementModel();
  return <section className="page"><h1>{model.t("manga.title")}</h1><p>{model.status}</p>
    <div className="card-stack"><MangaListCard model={model} /><TranslatorListCard model={model} />
      <ChapterSelectionCard model={model} /><AddChapterCard model={model} /><ChapterOrderCard model={model} />
    </div>
  </section>;
}
