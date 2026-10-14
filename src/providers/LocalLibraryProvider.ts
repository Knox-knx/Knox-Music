import { songRepo } from '../data/repositories';
import type { Album, Artist, Playlist, Song } from '../core/types';
import type { MusicProvider } from './types';

/** Searches the user's own local library DB. Always available, even offline. */
export class LocalLibraryProvider implements MusicProvider {
  readonly id = 'local';
  readonly name = 'Local Library';
  readonly capabilities = {
    supportsSearch: true,
    supportsStreaming: true,
    supportsOffline: true,
    supportsLyrics: true,
    supportsArtwork: true,
    supportsArtists: true,
    supportsAlbums: true,
  };

  async searchSongs(query: string): Promise<Song[]> {
    return songRepo.searchLocal(query, 50);
  }
  async searchArtists(query: string): Promise<Artist[]> {
    const songs = await songRepo.searchLocal(query, 200);
    const map = new Map<string, Artist>();
    for (const s of songs) {
      if (!s.artist.toLowerCase().includes(query.toLowerCase())) continue;
      const id = `local:${s.artist}`;
      if (!map.has(id)) map.set(id, { id, providerId: 'local', providerArtistId: s.artist, name: s.artist });
    }
    return [...map.values()].slice(0, 20);
  }
  async searchAlbums(query: string): Promise<Album[]> {
    const songs = await songRepo.searchLocal(query, 200);
    const map = new Map<string, Album>();
    for (const s of songs) {
      if (!s.album.toLowerCase().includes(query.toLowerCase())) continue;
      const id = `local:${s.album}::${s.artist}`;
      if (!map.has(id)) {
        map.set(id, {
          id, providerId: 'local', providerAlbumId: s.album, title: s.album,
          artist: s.artist, artworkUrl: s.artworkUrl,
        });
      }
    }
    return [...map.values()].slice(0, 20);
  }
  async searchPlaylists(): Promise<Playlist[]> { return []; }
  async getSong(id: string): Promise<Song | null> {
    return (await songRepo.get(id)) ?? null;
  }
  async getArtist(): Promise<Artist | null> { return null; }
  async getAlbum(): Promise<Album | null> { return null; }
  async getPlaylist(): Promise<Playlist | null> { return null; }
  async getAlbumTracks(): Promise<Song[]> { return []; }
  async getStream(song: Song) {
    if (song.isLocalFile && song.streamUrl) return { url: song.streamUrl, mimeType: 'audio/*', quality: 'Original file', allowsOffline: true };
    if (song.streamUrl) return { url: song.streamUrl, mimeType: 'audio/mpeg', quality: 'Original', allowsOffline: true };
    throw new Error('No playable source for local track');
  }
  async getArtwork(song: Song): Promise<string | null> {
    return song.artworkLocal ?? song.artworkUrl ?? null;
  }
  async getLyrics(): Promise<null> { return null; }
}
