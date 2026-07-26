import { apiFetch } from "./client";

function buildKnowledgeUrl(mangaId: string, asset: string, translatorId?: string | null) {
  const url = new URL(`/knowledge/${encodeURIComponent(mangaId)}/${asset}`, window.location.origin);
  if (translatorId?.trim()) {
    url.searchParams.set("translatorId", translatorId.trim());
  }
  return `${url.pathname}${url.search}`;
}

export function getGlossary(mangaId: string, translatorId?: string | null): Promise<unknown> {
  return apiFetch(buildKnowledgeUrl(mangaId, "glossary", translatorId));
}

export function getStyleProfile(mangaId: string, translatorId?: string | null): Promise<unknown> {
  return apiFetch(buildKnowledgeUrl(mangaId, "style-profile", translatorId));
}

export function getStoryContext(mangaId: string, translatorId?: string | null): Promise<unknown> {
  return apiFetch(buildKnowledgeUrl(mangaId, "story-context", translatorId));
}
