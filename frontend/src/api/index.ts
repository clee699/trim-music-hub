import type { TaskState, QueueTask, SearchSong, PlaylistSummary, PlaylistPreview, PlaylistTrack, LibraryTrack, HistoryItem, SettingsData, AuthorizedDirectory, DuplicateResult, MusicAccount, RemotePlaylist, CurrentUser, AccountSettingsPayload } from '../types';

export function getGatewayBasePrefix(): string {
  if (typeof window === 'undefined') return '';
  const m = window.location.pathname.match(/^(\/app\/[A-Za-z0-9_-]+)(?:\/|$)/);
  return m ? m[1] : '';
}

export function resolveApiUrl(path: string): string {
  if (!path.startsWith('/')) return path;
  const prefix = getGatewayBasePrefix();
  return prefix ? `${prefix}${path}` : path;
}

async function fetchWithAuth(url: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(resolveApiUrl(url), {
    credentials: 'include',
    ...init,
  });
  if (res.status === 401 && !url.includes('/api/auth/')) {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('auth:unauthorized'));
    }
  }
  return res;
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetchWithAuth(url, init);
  const text = await res.text();
  if (!text) {
    return { ok: res.ok, error: res.ok ? undefined : `服务响应为空 (HTTP ${res.status})` } as unknown as T;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    return {
      ok: false,
      error: res.status >= 500
        ? `后端网关或服务暂时不可用 (HTTP ${res.status})`
        : `响应解析异常 (HTTP ${res.status})`
    } as unknown as T;
  }
}

export const api = {
  async getAuthMe(): Promise<{ ok: boolean; loggedIn: boolean; user?: CurrentUser }> {
    return requestJson('/api/auth/me');
  },

  async login(username: string, password: string): Promise<{ ok: boolean; user?: CurrentUser; error?: string }> {
    return requestJson('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
  },

  async logout(): Promise<{ ok: boolean; message?: string }> {
    return requestJson('/api/auth/logout', { method: 'POST' });
  },

  async getMusicAccounts(): Promise<{ ok: boolean; data: MusicAccount[] }> {
    return requestJson('/api/music-accounts');
  },

  async createNeteaseQr(): Promise<{ ok: boolean; unikey?: string; qr_url?: string; qr_img?: string; error?: string }> {
    return requestJson('/api/music-accounts/netease/qr/create', { method: 'POST' });
  },

  async checkNeteaseQr(unikey: string): Promise<{ ok: boolean; status?: 'waiting' | 'scanned' | 'expired' | 'success' | 'unknown'; code?: number; message?: string; account?: MusicAccount; error?: string }> {
    return requestJson('/api/music-accounts/netease/qr/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unikey })
    });
  },

  async connectMusicAccount(target: string, cookie: string): Promise<{ ok: boolean; data?: MusicAccount; error?: string }> {
    return requestJson(`/api/music-accounts/${ encodeURIComponent(target) }`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cookie })
    });
  },

  async disconnectMusicAccount(target: string): Promise<{ ok: boolean; error?: string }> {
    return requestJson(`/api/music-accounts/${ encodeURIComponent(target) }`, { method: 'DELETE' });
  },

  async getMusicAccountPlaylists(target: string): Promise<{ ok: boolean; data?: RemotePlaylist[]; error?: string }> {
    return requestJson(`/api/music-accounts/${ encodeURIComponent(target) }/playlists`);
  },

  async importMusicAccountPlaylist(target: string, payload: { urls: string[]; target: string; user: string; quality?: string }): Promise<{ ok: boolean; message?: string; error?: string }> {
    return requestJson(`/api/music-accounts/${ encodeURIComponent(target) }/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  },

  async getDailyRecommend(target: string): Promise<{ ok: boolean; data?: PlaylistPreview; error?: string }> {
    return requestJson(`/api/music-accounts/${ encodeURIComponent(target) }/daily-recommend`);
  },

  async updateAccountSettings(target: string, payload: AccountSettingsPayload): Promise<{ ok: boolean; data?: MusicAccount; error?: string }> {
    return requestJson(`/api/music-accounts/${ encodeURIComponent(target) }/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  },

  async syncDailyRecommend(target: string): Promise<{ ok: boolean; data?: { ok: boolean; playlist_name: string; track_count: number; message: string }; error?: string }> {
    return requestJson(`/api/music-accounts/${ encodeURIComponent(target) }/daily-sync`, {
      method: 'POST'
    });
  },

  async getStatus(): Promise<{ ok: boolean; data: TaskState; isRunning: boolean }> {
    return requestJson('/api/status');
  },

  async getSettings(): Promise<{ ok: boolean; data: SettingsData; error?: string }> {
    return requestJson('/api/settings');
  },

  async updateSettings(
    download_source?: string,
    custom_source?: any,
    download_dir?: string,
    is_configured?: boolean,
    concurrent_downloads?: number,
    force_transcode?: boolean,
    transcode_quality?: 'flac24bit' | 'flac' | '320k' | '128k'
  ): Promise<{ ok: boolean; data: SettingsData; error?: string }> {
    const payload: any = {};
    if (download_source !== undefined) payload.download_source = download_source;
    if (custom_source !== undefined) payload.custom_source = custom_source;
    if (download_dir !== undefined) payload.download_dir = download_dir;
    if (is_configured !== undefined) payload.is_configured = is_configured;
    if (concurrent_downloads !== undefined) payload.concurrent_downloads = concurrent_downloads;
    if (force_transcode !== undefined) payload.force_transcode = force_transcode;
    if (transcode_quality !== undefined) payload.transcode_quality = transcode_quality;
    return requestJson('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  },

  async getAuthorizedDirectories(): Promise<{ ok: boolean; data: AuthorizedDirectory[]; error?: string }> {
    return requestJson('/api/settings/directories');
  },

  async verifyDirectory(path: string): Promise<{
    ok: boolean;
    error?: string;
    data: {
      ok: boolean;
      path: string;
      exists: boolean;
      writable: boolean;
      is_fnos_authorized: boolean;
      error: string | null;
    };
  }> {
    return requestJson('/api/settings/verify-directory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path })
    });
  },

  async getUsers(): Promise<{ ok: boolean; data: Array<{ id: number; name: string; role?: string }> }> {
    return requestJson('/api/users');
  },

  async parsePlaylist(url: string, accountId?: string): Promise<{ ok: boolean; data?: PlaylistPreview; error?: string }> {
    return requestJson('/api/tasks/parse-playlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, account_id: accountId })
    });
  },

  async querySourceQualities(source: string, tracks: Array<{ index: number; title: string; artist: string; exists?: boolean }>): Promise<{ ok: boolean; data?: Array<{ index: number; available_qualities: string[] }>; error?: string }> {
    return requestJson('/api/tasks/query-source-qualities', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source, tracks })
    });
  },

  async startTask(payload: {
    url: string;
    target: string;
    user: string;
    playlist_name?: string;
    quality?: string;
    tracks?: PlaylistPreview['tracks'];
    source?: string;
    cover_url?: string;
    account_id?: string;
  }): Promise<{ ok: boolean; message: string; error?: string }> {
    return requestJson('/api/tasks/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  },

  async stopTask(): Promise<{ ok: boolean; message: string; error?: string }> {
    return requestJson('/api/tasks/stop', { method: 'POST' });
  },

  async getTaskQueue(): Promise<{ ok: boolean; data: QueueTask[]; isAdmin?: boolean; error?: string }> {
    return requestJson('/api/tasks/queue');
  },

  async reorderTasks(taskIds: string[]): Promise<{ ok: boolean; message?: string; error?: string }> {
    return requestJson('/api/tasks/reorder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task_ids: taskIds })
    });
  },

  async cancelTask(taskId: string): Promise<{ ok: boolean; message?: string; error?: string }> {
    return requestJson('/api/tasks/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task_id: taskId })
    });
  },

  async resumeTask(taskId: string): Promise<{ ok: boolean; message?: string; error?: string }> {
    return requestJson('/api/tasks/resume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task_id: taskId })
    });
  },

  async clearCompletedTasks(): Promise<{ ok: boolean; message?: string; error?: string }> {
    return requestJson('/api/tasks/clear-completed', { method: 'POST' });
  },

  async searchOnline(keyword: string, page = 1, pageSize = 20): Promise<{ ok: boolean; data: SearchSong[]; page: number; page_size: number; total: number; has_more: boolean; error?: string }> {
    return requestJson(`/api/search/online?q=${encodeURIComponent(keyword)}&page=${page}&page_size=${pageSize}`);
  },

  async downloadSingle(payload: {
    artist: string;
    song: string;
    album?: string;
    cover?: string;
    quality: string;
    source?: 'kw' | 'kg' | 'tx' | 'wy' | 'auto' | 'custom';
    force?: boolean;
  }): Promise<{ ok: boolean; message?: string; error?: string; path?: string }> {
    return requestJson('/api/download/single', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  },

  async getPlaylists(): Promise<{ ok: boolean; data: PlaylistSummary[]; error?: string }> {
    return requestJson('/api/playlists');
  },

  async getPlaylistTracks(name: string, playlistId?: number, playlistIds?: number[]): Promise<{ ok: boolean; data: PlaylistTrack[]; error?: string }> {
    const params = new URLSearchParams();
    if (name) params.set('name', name);
    if (playlistId !== undefined && playlistId !== null) params.set('playlist_id', String(playlistId));
    if (Array.isArray(playlistIds) && playlistIds.length > 0) params.set('playlist_ids', playlistIds.join(','));
    return requestJson(`/api/playlists/tracks?${params.toString()}`);
  },

  async renamePlaylist(oldName: string, newName: string, playlistId?: number, playlistIds?: number[]): Promise<{ ok: boolean; message?: string; error?: string }> {
    return requestJson('/api/playlists/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ old_name: oldName, new_name: newName, playlist_id: playlistId, playlist_ids: playlistIds })
    });
  },

  async updatePlaylistUsers(name: string, userIds: number[], playlistId?: number, playlistIds?: number[]): Promise<{ ok: boolean; message?: string; error?: string }> {
    return requestJson('/api/playlists/update-users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, user_ids: userIds, playlist_id: playlistId, playlist_ids: playlistIds })
    });
  },

  async removePlaylistTracks(name: string, trackIds: number[], removePhysical = false, playlistId?: number, playlistIds?: number[]): Promise<{ ok: boolean; message?: string; error?: string }> {
    return requestJson('/api/playlists/remove-tracks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, track_ids: trackIds, remove_physical: removePhysical, playlist_id: playlistId, playlist_ids: playlistIds })
    });
  },

  async deletePlaylist(name: string, deleteTracks: boolean, playlistId?: number, playlistIds?: number[]): Promise<{ ok: boolean; message?: string; error?: string; deleted_files?: number }> {
    return requestJson('/api/playlists/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, delete_tracks: deleteTracks, playlist_id: playlistId, playlist_ids: playlistIds })
    });
  },

  async searchLibraryTracks(query: string, page = 1, limit = 50): Promise<{ ok: boolean; data: { total: number; page: number; limit: number; list: LibraryTrack[] }; error?: string }> {
    return requestJson(`/api/tracks/search?q=${encodeURIComponent(query)}&page=${page}&limit=${limit}`);
  },

  async getDuplicateTracks(query = ''): Promise<{ ok: boolean; data: DuplicateResult; error?: string }> {
    return requestJson(`/api/tracks/duplicates?q=${encodeURIComponent(query)}`);
  },

  async deleteTrack(trackId: number, removePhysical = true): Promise<{ ok: boolean; message?: string; error?: string }> {
    return requestJson('/api/tracks/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ track_id: trackId, remove_physical: removePhysical })
    });
  },

  async batchDeleteTracks(trackIds: number[], removePhysical = true): Promise<{ ok: boolean; message?: string; error?: string; deleted_count?: number; failed_count?: number }> {
    return requestJson('/api/tracks/batch-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ track_ids: trackIds, remove_physical: removePhysical })
    });
  },

  async getHistory(): Promise<{ ok: boolean; data: HistoryItem[]; error?: string }> {
    return requestJson('/api/history');
  },

  async deleteHistory(id: number): Promise<{ ok: boolean; error?: string }> {
    return requestJson('/api/history/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id })
    });
  },

  async clearHistory(): Promise<{ ok: boolean; error?: string }> {
    return requestJson('/api/history/clear', { method: 'POST' });
  },

  async getLogs(): Promise<{ ok: boolean; data: string; error?: string }> {
    return requestJson('/api/logs');
  },

  async clearLogs(): Promise<{ ok: boolean; error?: string }> {
    return requestJson('/api/logs/clear', { method: 'POST' });
  }
};
