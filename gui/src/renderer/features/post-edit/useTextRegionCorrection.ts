import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import {
  createTextRegionCorrectionJob,
  getTextRegions,
  type EditedSceneNode,
  type EditedScenePage,
  type TextRegion,
  type TextRegionCorrectionRequest,
  type TextRegionGeometry,
  type TextRegionPage,
  type TextRegionSnapshot,
} from "../../api/jobs";
import { useUiStore } from "../../stores/ui_store";

type Translate = (key: string, params?: Record<string, string | number>) => string;
type GeometryField = keyof TextRegionGeometry;
type GeometryDraft = Record<GeometryField, string>;
export type TextRegionCorrectionDraft = { sourceText: string; geometry: GeometryDraft };
type CorrectionContext = { page: TextRegionPage; region: TextRegion };

function resolveContext(
  snapshot: TextRegionSnapshot | undefined,
  page: EditedScenePage | null,
  node: EditedSceneNode | null,
): CorrectionContext | null {
  if (!snapshot || !page?.sourceImageId || !node?.regionId) return null;
  const regionPage = snapshot.pages.find((entry) => entry.sourceImageId === page.sourceImageId);
  const region = regionPage?.regions.find((entry) => entry.id === node.regionId);
  return regionPage && region ? { page: regionPage, region } : null;
}

function draftFromContext(context: CorrectionContext): TextRegionCorrectionDraft {
  return {
    sourceText: context.region.sourceText,
    geometry: Object.fromEntries(
      Object.entries(context.region.geometry).map(([field, value]) => [field, String(value)]),
    ) as GeometryDraft,
  };
}

function numericGeometry(draft: TextRegionCorrectionDraft): TextRegionGeometry {
  return Object.fromEntries(
    Object.entries(draft.geometry).map(([field, value]) => [field, Number(value)]),
  ) as TextRegionGeometry;
}

function geometryIsValid(geometry: TextRegionGeometry, page: TextRegionPage) {
  const values = Object.values(geometry);
  return values.every(Number.isFinite) && geometry.x >= 0 && geometry.y >= 0
    && geometry.width > 0 && geometry.height > 0
    && geometry.x + geometry.width <= page.coordinateSpace.width
    && geometry.y + geometry.height <= page.coordinateSpace.height;
}

function correctionChanged(context: CorrectionContext, draft: TextRegionCorrectionDraft) {
  return draft.sourceText !== context.region.sourceText
    || JSON.stringify(numericGeometry(draft)) !== JSON.stringify(context.region.geometry);
}

function correctionRequest(
  context: CorrectionContext,
  draft: TextRegionCorrectionDraft,
): TextRegionCorrectionRequest {
  return { pages: [{
    sourceImageId: context.page.sourceImageId,
    baseRegionSetRevisionId: context.page.regionSetRevisionId,
    regions: [{ regionId: context.region.id, sourceText: draft.sourceText, geometry: numericGeometry(draft) }],
  }] };
}

function useCorrectionDraft(context: CorrectionContext | null) {
  const [draft, setDraft] = useState<TextRegionCorrectionDraft | null>(null);
  useEffect(() => setDraft(context ? draftFromContext(context) : null), [
    context?.page.sourceImageId,
    context?.page.regionSetRevisionId,
    context?.region.id,
  ]);
  return { draft, setDraft };
}

function useCorrectionMutation(jobId: string | null, setStatus: (value: string) => void, t: Translate) {
  const client = useQueryClient();
  const selectJob = useUiStore((state) => state.setSelectedJobId);
  const selectPage = useUiStore((state) => state.setSelectedPage);
  return useMutation({
    mutationFn: (request: TextRegionCorrectionRequest) => createTextRegionCorrectionJob(jobId as string, request),
    onSuccess: async (job) => {
      setStatus(t("postEdit.correction.queued", { jobId: job.id }));
      selectJob(job.id);
      selectPage("job-list");
      await client.invalidateQueries({ queryKey: ["jobs"] });
    },
    onError: (error) => setStatus(error instanceof Error ? error.message : t("postEdit.correction.failed")),
  });
}

export function useTextRegionCorrection(input: {
  jobId: string | null;
  page: EditedScenePage | null;
  node: EditedSceneNode | null;
  setStatus: (value: string) => void;
  t: Translate;
}) {
  const query = useQuery({
    queryKey: ["text-regions", input.jobId],
    queryFn: () => getTextRegions(input.jobId as string),
    enabled: Boolean(input.jobId),
    retry: false,
  });
  const context = useMemo(
    () => resolveContext(query.data, input.page, input.node),
    [query.data, input.page?.sourceImageId, input.node?.regionId],
  );
  const { draft, setDraft } = useCorrectionDraft(context);
  const mutation = useCorrectionMutation(input.jobId, input.setStatus, input.t);
  const geometry = draft ? numericGeometry(draft) : null;
  const valid = Boolean(context && draft?.sourceText.trim() && geometry && geometryIsValid(geometry, context.page));
  const changed = Boolean(context && draft && correctionChanged(context, draft));
  const updateSourceText = (sourceText: string) => setDraft((value) => value && { ...value, sourceText });
  const updateGeometry = (field: GeometryField, value: string) => setDraft((current) => current && ({
    ...current, geometry: { ...current.geometry, [field]: value },
  }));
  const submit = () => context && draft && mutation.mutate(correctionRequest(context, draft));
  return { query, context, draft, mutation, valid, changed, updateSourceText, updateGeometry, submit };
}

export type TextRegionCorrectionController = ReturnType<typeof useTextRegionCorrection>;
