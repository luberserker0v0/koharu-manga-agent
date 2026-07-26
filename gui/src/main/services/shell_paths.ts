import { app } from "electron";

export const shellPaths = {
  userData: app.getPath("userData"),
  downloads: app.getPath("downloads"),
  documents: app.getPath("documents"),
};
