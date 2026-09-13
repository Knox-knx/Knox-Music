import type { Album, Artist, Playlist, Song } from '../core/types';
import type { MusicProvider, StreamResult } from './types';

/**
 * Sample catalog — openly usable demo tracks for development/testing.
 * Uses SoundHelix sample MP3s (explicitly provided for testing) which permit
 * streaming AND local caching for demo purposes. Clearly labelled as samples.
 * Real catalogs (Jamendo, Internet Archive, FreeToUse, AirBeats, YouTube Music
 * discovery) live in their own provider adapters.
 */
const TRACKS: Song[] = Array.from({ length: 12 }, (_, i) => {
  const n = i + 1;
  return {
    id: `sample:sample-${n}`,
    providerId: 'sample',
    providerTrackId: `sample-${n}`,
    title: `SoundHelix Song ${n}`,
    artist: 'SoundHelix (Demo)',
    artistId: 'sample:artist-soundhelix',
    album: 'SoundHelix Samples',
    albumId: 'sample:album-soundhelix',
    durationMs: (360 + n * 17) * 1000,
    artworkUrl: undefined,
    genre: 'Electronic',
    year: 2014,
    trackNo: n,
    addedAt: Date.now() - n * 86400000,
  };
});

const ARTIST: Artist = {
  id: 'sample:artist-soundhelix',
  providerId: 'sample',
  providerArtistId: 'artist-soundhelix',
  name: 'SoundHelix (Demo)',
  bio: 'Demo catalog for development. Replace with a licensed provider for production.',
};

const ALBUM: Album = {
  id: 'sample:album-soundhelix',
  providerId: 'sample',
  providerAlbumId: 'album-soundhelix',
  title: 'SoundHelix Samples',
  artist: 'SoundHelix (Demo)',
  artistId: ARTIST.id,
  year: 2014,
  trackCount: TRACKS.length,
};

export class SampleCatalogProvider implements MusicProvider {
  readonly id = 'sample';
  readonly name = 'Sample Catalog (Demo)';
  readonly capabilities = {
    supportsSearch: true,
    supportsStreaming: true,
    supportsOffline: true,
    supportsLyrics: false,
    supportsArtwork: false,
    supportsArtists: true,
    supportsAlbums: true,
  };
  readonly offlineNotice = 'Demo tracks may be stored offline for testing.';

  private match(q: string, ...fields: (string | undefined)[]): boolean {
    const needle = q.toLowerCase();
    return fields.some((f) => (f || '').toLowerCase().includes(needle));
  }

  async searchSongs(query: string): Promise<Song[]> {
    return TRACKS.filter((t) => this.match(query, t.title, t.artist, t.album));
  }
  async searchArtists(query: string): Promise<Artist[]> {
    return this.match(query, ARTIST.name) ? [ARTIST] : [];
  }
  async searchAlbums(query: string): Promise<Album[]> {
    return this.match(query, ALBUM.title, ALBUM.artist) ? [ALBUM] : [];
  }
  async searchPlaylists(): Promise<Playlist[]> { return []; }
  async getSong(id: string): Promise<Song | null> {
    return TRACKS.find((t) => t.providerTrackId === id) ?? null;
  }
  async getArtist(): Promise<Artist | null> { return ARTIST; }
  async getAlbum(): Promise<Album | null> { return ALBUM; }
  async getPlaylist(): Promise<Playlist | null> { return null; }
  async getAlbumTracks(_albumId?: string): Promise<Song[]> { return TRACKS; }
  async getStream(song: Song): Promise<StreamResult> {
    const n = song.providerTrackId.replace('sample-', '');
    return {
      url: `https://www.soundhelix.com/examples/mp3/SoundHelix-Song-${n}.mp3`,
      mimeType: 'audio/mpeg',
      quality: 'Normal (128 kbps demo)',
      allowsOffline: true,
    };
  }
  async getArtwork(): Promise<string | null> { return null; }
  async getLyrics(): Promise<null> { return null; }
}

/**
 * Backwards-compatible re-export: the real Jamendo implementation now lives
 * in ./jamendo/provider.ts. Kept so older imports keep working.
 */
export { JamendoProvider } from './jamendo/provider';
