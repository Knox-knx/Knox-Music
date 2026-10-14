// Type surface of services/audioService.js for tests/tooling.
export function resolveExecutable(name: string, envVar: string): string;
export function resolvedBinaries(): { ytDlp: string; ffmpeg: string; node: string };
export function isValidVideoId(videoId: unknown): boolean;
export function permanentFilename(videoId: string): string;
export function createAudioService(opts: {
  config: Record<string, unknown>;
  logger?: unknown;
}): Record<string, unknown>;
