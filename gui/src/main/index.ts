import { app } from "electron";
import { registerIpcHandlers } from "./ipc/handlers";
import { backendProcessService } from "./services/backend_process";
import { SettingsStore } from "./services/settings_store";
import { koharuHostProcessService } from "./services/koharu_host_process";
import { createMainWindow } from "./windows/main_window";

async function bootstrap(): Promise<void> {
  await app.whenReady();
  const settingsStore = new SettingsStore();
  const settings = settingsStore.initialize();
  try {
    await koharuHostProcessService.ensureStarted({
      autoStart: settings.koharuAutoStart,
      executablePath: settings.koharuExecutablePath,
    });
  } catch (error) {
    console.error("Koharu host startup failed:", error);
  }
  try {
    await backendProcessService.ensureStarted(settings.backendBaseUrl);
  } catch (error) {
    console.error("Backend startup failed:", error);
  }
  registerIpcHandlers(settingsStore);
  await createMainWindow(backendProcessService.getState().baseUrl);

  app.on("activate", async () => {
    if (process.platform !== "darwin") {
      return;
    }
    await createMainWindow(backendProcessService.getState().baseUrl);
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  void koharuHostProcessService.stopManaged();
  void backendProcessService.stopManaged();
});

bootstrap().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("Failed to bootstrap GUI:", error);
  app.exit(1);
});
