import type { MangaProcessorHostService } from "./manga_processor_host_contract";
import { koharuHostProcessService } from "./koharu_host_process";

export const mangaProcessorHostService: MangaProcessorHostService = koharuHostProcessService;
