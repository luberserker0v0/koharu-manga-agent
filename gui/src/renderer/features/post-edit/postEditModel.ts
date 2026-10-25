import { buildApiUrl } from "../../api/client";
import type { EditedSceneDocument, GuiJob, TranslatedImage } from "../../api/jobs";

export function moveId(ids: string[], draggedId: string, targetId: string) {
  const from = ids.indexOf(draggedId);
  const to = ids.indexOf(targetId);
  if (from < 0 || to < 0 || from === to) return ids;
  const next = ids.slice();
  next.splice(to, 0, next.splice(from, 1)[0]);
  return next;
}

export function cloneScene(scene: EditedSceneDocument): EditedSceneDocument {
  return structuredClone(scene);
}

export function isEditableJob(job: GuiJob) {
  if (!(["translation", "translation_quality_repair"] as string[]).includes(job.type) || job.status !== "succeeded") {
    return false;
  }
  if (!job.artifacts.some((artifact) => ["post_edit_document", "edited_scene"].includes(artifact.kind))) return false;
  const result = job.result as { publication?: { status?: string } } | null;
  return result?.publication?.status !== "superseded";
}

export function translatedImageForPage(images: TranslatedImage[], sourceOrder: string[], pageId: string) {
  const matched = images.find((image) => image.fileName.includes(pageId));
  if (matched) return matched;
  const index = sourceOrder.indexOf(pageId);
  return index >= 0 ? images.find((image) => image.index === index) || images[index] || null : null;
}

export function translatedImageUrl(image: TranslatedImage) {
  return /^https?:\/\//i.test(image.contentUrl) ? image.contentUrl : buildApiUrl(image.contentUrl);
}

export function payloadString(job: GuiJob | null, key: string) {
  const value = job?.payload[key];
  return typeof value === "string" ? value : "";
}

export function updateNodeTranslation(scene: EditedSceneDocument, pageId: string, nodeId: string, value: string) {
  const page = scene.pages[pageId];
  if (!page?.nodes[nodeId]) return scene;
  const node = { ...page.nodes[nodeId], editedTranslation: value };
  return { ...scene, pages: { ...scene.pages, [pageId]: { ...page, nodes: { ...page.nodes, [nodeId]: node } } } };
}

export function reorderPages(scene: EditedSceneDocument, draggedId: string, targetId: string) {
  return { ...scene, pageOrder: moveId(scene.pageOrder, draggedId, targetId) };
}

export function reorderNodes(scene: EditedSceneDocument, pageId: string, draggedId: string, targetId: string) {
  const page = scene.pages[pageId];
  if (!page) return scene;
  const updated = { ...page, nodeOrder: moveId(page.nodeOrder, draggedId, targetId) };
  return { ...scene, pages: { ...scene.pages, [pageId]: updated } };
}
