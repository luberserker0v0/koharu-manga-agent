import { app } from "electron";
import { registerIpcHandlers } from "./ipc/handlers";
import { backendProcessService } from "./services/backend_process";
import { createMainWindow } from "./windows/main_window";

async function bootstrap(): Promise<void> {
  await app.whenReady();
  await backendProcessService.ensureStarted();
  registerIpcHandlers();
  await createMainWindow();

  app.on("activate", async () => {
    if (process.platform !== "darwin") {
      return;
    }
    await createMainWindow();
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  void backendProcessService.stopManaged();
});

bootstrap().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("Failed to bootstrap GUI:", error);
  app.exit(1);
});
