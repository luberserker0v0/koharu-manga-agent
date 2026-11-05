export type MangaProcessorHostStatus =
  | "checking"
  | "downloading"
  | "running"
  | "stopped"
  | "unavailable"
  | "failed";

export type MangaProcessorHostState = {
  providerId: string;
  providerName: string;
  mode: "external" | "managed";
  status: MangaProcessorHostStatus;
  baseUrl: string;
  executablePath: string | null;
  pid: number | null;
  note: string;
};

export interface MangaProcessorHostService {
  getState(): MangaProcessorHostState;
  inspect(): Promise<MangaProcessorHostState>;
  ensureStarted(options: { autoStart: boolean; executablePath: string }): Promise<MangaProcessorHostState>;
  installAndStart(): Promise<MangaProcessorHostState>;
  start(executablePath: string): Promise<MangaProcessorHostState>;
  stopManaged(): Promise<MangaProcessorHostState>;
}
