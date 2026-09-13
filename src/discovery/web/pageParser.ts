// Web Discovery — page parser (thin wrapper over the hardened extractor).
//
// Static string parsing only — never executes page JavaScript.
// Layers: JSON-LD (MusicRecording/MusicAlbum/MusicGroup/MusicPlaylist) →
// OpenGraph/music:* → <title>/meta → null. Prefers JSON-LD over weak
// metadata. Extracts title/artist/album/duration/artwork/description/date/
// canonical URL. Re-exported here so the web/ subsystem is self-contained.

export { extractPageMetadata } from '../metadataExtractor';
export type { PageMetadata } from '../types';
