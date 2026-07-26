export const ROUTES = [
  { key: "settings", labelKey: "route.settings" },
  { key: "job", labelKey: "route.job" },
  { key: "manga", labelKey: "route.manga" },
  { key: "reference", labelKey: "route.reference" },
  { key: "post-edit", labelKey: "route.postEdit" },
  { key: "job-list", labelKey: "route.jobList" },
] as const;

export type RouteKey = (typeof ROUTES)[number]["key"];
