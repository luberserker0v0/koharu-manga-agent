import type { BackendStoragePaths, KoharuRuntimePaths } from "../../../api/runtime";
import type { DesktopInfo, GuiSettings } from "../../../types/settings";

type Translate = (key: string, params?: Record<string, string | number>) => string;

type StorageLocationsProps = {
  backend?: BackendStoragePaths;
  desktopInfo: DesktopInfo | null;
  koharu?: KoharuRuntimePaths;
  onOpen: (targetPath: string) => Promise<void>;
  settings: GuiSettings;
  t: Translate;
};

type Location = {
  label: string;
  value: string | null | undefined;
};

type LocationGroup = {
  accessibilityLabel: string;
  accessible: boolean;
  description: string;
  id: "gui" | "backend" | "koharu";
  locations: Location[];
  mark: string;
  title: string;
};

export function StorageLocations({ backend, desktopInfo, koharu, onOpen, settings, t }: StorageLocationsProps) {
  const groups: LocationGroup[] = [
    {
      id: "gui",
      mark: "UI",
      title: t("settings.storage.group.gui"),
      description: t("settings.storage.group.guiDescription"),
      accessible: true,
      accessibilityLabel: t("settings.storage.hostAccessible"),
      locations: [
        { label: t("settings.storage.guiData"), value: desktopInfo?.shellPaths.userData },
        { label: t("settings.storage.guiSettings"), value: desktopInfo?.settingsFilePath },
        { label: t("settings.storage.output"), value: settings.outputFolder },
        { label: t("settings.storage.reference"), value: settings.referenceFolder },
      ],
    },
    {
      id: "backend",
      mark: "API",
      title: t("settings.storage.group.backend"),
      description: t("settings.storage.group.backendDescription"),
      accessible: backend?.hostAccessible === true,
      accessibilityLabel: backend?.hostAccessible === true
        ? t("settings.storage.hostAccessible")
        : t("settings.storage.dockerManaged"),
      locations: [
        { label: t("settings.storage.backendData"), value: backend?.dataRoot },
        { label: t("settings.storage.backendConfig"), value: backend?.configPath },
        { label: t("settings.storage.backendDatabase"), value: backend?.databasePath },
        { label: t("settings.storage.backendExports"), value: backend?.translatedRoot },
        { label: t("settings.storage.backendReferences"), value: backend?.referencesRoot },
      ],
    },
    {
      id: "koharu",
      mark: "K",
      title: t("settings.storage.group.koharu"),
      description: t("settings.storage.group.koharuDescription"),
      accessible: koharu?.hostAccessible === true,
      accessibilityLabel: koharu?.hostAccessible === true
        ? t("settings.storage.hostAccessible")
        : t("settings.storage.serviceManaged"),
      locations: [
        { label: t("settings.storage.koharuData"), value: koharu?.dataRoot },
        { label: t("settings.storage.koharuConfig"), value: koharu?.configPath },
        { label: t("settings.storage.koharuProjects"), value: koharu?.projectsRoot },
        { label: t("settings.storage.koharuModels"), value: koharu?.modelsRoot },
      ],
    },
  ];

  return (
    <div className="storage-group-grid">
      {groups.map((group) => (
        <section className={`storage-group storage-group-${group.id}`} key={group.id}>
          <header className="storage-group-header">
            <div className="storage-group-identity">
              <span aria-hidden="true" className="storage-group-mark">{group.mark}</span>
              <div>
                <h3>{group.title}</h3>
                <p>{group.description}</p>
              </div>
            </div>
            <span className={`storage-access-pill ${group.accessible ? "is-accessible" : "is-managed"}`}>
              {group.accessibilityLabel}
            </span>
          </header>
          <div className="storage-location-list">
            {group.locations.map((location) => {
              const value = location.value?.trim() || "";
              return (
                <div className="storage-location-row" key={location.label}>
                  <div className="storage-location-copy">
                    <span>{location.label}</span>
                    <code title={value || undefined}>{value || t("settings.storage.unavailable")}</code>
                  </div>
                  {value && group.accessible ? (
                    <button
                      className="storage-open-button"
                      onClick={() => void onOpen(value)}
                      title={`${t("settings.storage.open")}: ${value}`}
                      type="button"
                    >
                      {t("settings.storage.open")}
                      <span aria-hidden="true">↗</span>
                    </button>
                  ) : (
                    <span className="storage-location-state">
                      {value ? group.accessibilityLabel : t("settings.storage.unavailable")}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
