<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from 'vue';
import type { TaskState, QueueTask, CurrentUser } from './types';
import { api, resolveApiUrl } from './api';
import { showToast } from './composables/useToast';
import { useTheme } from './composables/useTheme';
import Header from './components/Header.vue';
import Toast from './components/Toast.vue';
import MonitorTab from './components/tabs/MonitorTab.vue';
import SearchTab from './components/tabs/SearchTab.vue';
import PlaylistTab from './components/tabs/PlaylistTab.vue';
import LibraryTab from './components/tabs/LibraryTab.vue';
import HistoryTab from './components/tabs/HistoryTab.vue';
import SettingsModal from './components/modals/SettingsModal.vue';
import MusicAccountsModal from './components/modals/MusicAccountsModal.vue';
import LoginModal from './components/modals/LoginModal.vue';
import MobileTaskPill from './components/mobile/MobileTaskPill.vue';

useTheme();
type TabKey = 'monitor' | 'search' | 'playlists' | 'library' | 'history';
const activeTab = ref<TabKey>('monitor');
const visitedTabs = ref<Set<TabKey>>(new Set(['monitor']));

watch(activeTab, (tab) => {
  if (!visitedTabs.value.has(tab)) {
    visitedTabs.value.add(tab);
  }
});

const connected = ref(false);
const settingsModalOpen = ref(false);
const accountsModalOpen = ref(false);
const loginModalOpen = ref(false);
const isFirstInstall = ref(false);
const currentUser = ref<CurrentUser | null>(null);
const historyRefreshKey = ref(0);
const hasActiveBatchSelection = ref(false);

const searchSubTab = ref<'parse' | 'search'>('parse');
const searchImportPayload = ref<{ url: string; accountId?: string; playlistName?: string; ts?: number } | null>(null);

function createIdleTask(): TaskState {
  return {
    status: 'idle',
    playlist_name: '还没有进行中的任务',
    platform: 'TRIM Music',
    target: 'public',
    user: 'all',
    total: 0,
    processed_count: 0,
    reused_count: 0,
    downloaded_count: 0,
    failed_count: 0,
    current_track: null,
    speed: null,
    start_time: null,
    end_time: null,
    tracks: [],
    updated_at: new Date().toISOString()
  };
}

function handleOpenImportTab(payload?: { url: string; accountId?: string; playlistName?: string }) {
  activeTab.value = 'search';
  searchSubTab.value = 'parse';
  if (payload) {
    searchImportPayload.value = { ...payload, ts: Date.now() };
  }
}

function handleOpenImportFromAccount(payload: { url: string; accountId?: string; playlistName?: string }) {
  accountsModalOpen.value = false;
  handleOpenImportTab(payload);
}

async function checkInitialization() {
  if (!currentUser.value?.isAdmin) return;
  try {
    const res = await api.getSettings();
    if (res.ok && res.data && (res.data.is_configured === false || !res.data.download_dir)) {
      isFirstInstall.value = true;
      settingsModalOpen.value = true;
    }
  } catch {}
}

const taskState = ref<TaskState>(createIdleTask());
const queue = ref<QueueTask[]>([]);
const logs = ref<string[]>([]);

async function loadQueue() {
  try {
    const res = await api.getTaskQueue();
    if (res.ok && Array.isArray(res.data)) {
      queue.value = res.data;
    }
  } catch {}
}

async function loadLogs() {
  try {
    const res = await api.getLogs();
    if (res.ok && typeof res.data === 'string') {
      logs.value = res.data ? res.data.split(/\r?\n/).filter(Boolean).slice(-500) : [];
    }
  } catch {}
}

async function handleClearLogs() {
  try {
    await api.clearLogs();
  } catch {}
  logs.value = [];
}

let eventSource: EventSource | null = null;

function closeSSE() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
  connected.value = false;
}

function applyIncomingTaskUpdate(incoming: TaskState) {
  if (incoming.track_update && !Array.isArray(incoming.tracks)) {
    const nextTracks = Array.isArray(taskState.value.tracks) ? [...taskState.value.tracks] : [];
    const { index, track } = incoming.track_update;
    if (typeof index === 'number' && index >= 0 && track) {
      nextTracks[index] = { ...(nextTracks[index] || {}), ...track };
    }
    const { track_update: _ignored, ...rest } = incoming;
    taskState.value = {
      ...taskState.value,
      ...rest,
      tracks: nextTracks
    };
  } else {
    taskState.value = {
      ...taskState.value,
      ...incoming,
      tracks: Array.isArray(incoming.tracks) ? incoming.tracks : (taskState.value.tracks || [])
    };
  }
}

function setupSSE() {
  closeSSE();
  eventSource = new EventSource(resolveApiUrl('/api/stream'));
  eventSource.onopen = () => {
    connected.value = true;
  };
  eventSource.onerror = () => {
    connected.value = false;
  };
  eventSource.addEventListener('init', (e: MessageEvent) => {
    try {
      const data = JSON.parse(e.data);
      taskState.value = { ...createIdleTask(), ...data, tracks: Array.isArray(data.tracks) ? data.tracks : [] };
      loadLogs();
    } catch {}
  });
  eventSource.addEventListener('status', (e: MessageEvent) => {
    try {
      const data = JSON.parse(e.data) as TaskState;
      applyIncomingTaskUpdate(data);
    } catch {}
  });
  eventSource.addEventListener('queue', (e: MessageEvent) => {
    try {
      queue.value = JSON.parse(e.data);
    } catch {}
  });
  eventSource.addEventListener('history', () => {
    historyRefreshKey.value += 1;
  });
  eventSource.addEventListener('speed', (e: MessageEvent) => {
    try {
      const payload = JSON.parse(e.data);
      if (taskState.value) {
        taskState.value.speed = payload.speed || '';
      }
    } catch {}
  });
  eventSource.addEventListener('log', (e: MessageEvent) => {
    try {
      const payload = JSON.parse(e.data);
      if (payload.text) {
        logs.value.push(payload.text);
        if (logs.value.length > 500) logs.value.shift();
      }
    } catch {}
  });
}

function resetUserSessionState() {
  closeSSE();
  currentUser.value = null;
  taskState.value = createIdleTask();
  queue.value = [];
  logs.value = [];
  hasActiveBatchSelection.value = false;
  visitedTabs.value = new Set(['monitor']);
  activeTab.value = 'monitor';
}

async function checkAuth() {
  try {
    const res = await api.getAuthMe();
    if (res.ok && res.loggedIn && res.user) {
      currentUser.value = res.user;
      loginModalOpen.value = false;
      setupSSE();
      loadQueue();
      checkInitialization();
    } else {
      resetUserSessionState();
      loginModalOpen.value = true;
    }
  } catch {
    resetUserSessionState();
    loginModalOpen.value = true;
  }
}

function handleLoggedIn(user: CurrentUser) {
  visitedTabs.value = new Set([activeTab.value]);
  queue.value = [];
  logs.value = [];
  historyRefreshKey.value += 1;
  currentUser.value = user;
  loginModalOpen.value = false;
  showToast(`欢迎回来，${user.username}（${user.isAdmin ? '管理员' : '普通成员'}）`, 'success');
  setupSSE();
  loadQueue();
  checkInitialization();
}

async function handleLogout() {
  try {
    await api.logout();
    resetUserSessionState();
    loginModalOpen.value = true;
    showToast('已安全退出当前账号', 'info');
  } catch (e: any) {
    showToast(`退出登录失败: ${e.message}`, 'error');
  }
}

async function handleStopTask() {
  try {
    const res = await api.stopTask();
    if (res.ok) {
      showToast('任务已停止，已完成的歌曲会保留。', 'warning');
    } else {
      showToast(res.error || '停止任务失败', 'error');
    }
  } catch (e: any) {
    showToast(`停止失败：${e.message}`, 'error');
  }
}

function handleUnauthorizedEvent() {
  resetUserSessionState();
  loginModalOpen.value = true;
}

onMounted(() => {
  if (typeof window !== 'undefined') {
    window.addEventListener('auth:unauthorized', handleUnauthorizedEvent);
  }
  checkAuth();
});

onUnmounted(() => {
  closeSSE();
  if (typeof window !== 'undefined') {
    window.removeEventListener('auth:unauthorized', handleUnauthorizedEvent);
  }
});
</script>

<template>
  <div class="min-h-screen bg-background text-foreground">
    <Header
      :active-tab="activeTab"
      :connected="connected"
      :current-user="currentUser"
      @update:active-tab="activeTab = $event; hasActiveBatchSelection = false;"
      @new-task="handleOpenImportTab()"
      @open-settings="settingsModalOpen = true"
      @open-accounts="accountsModalOpen = true"
      @logout="handleLogout"
    />
    <div class="lg:pl-[248px]">
      <main class="app-main-viewport mx-auto w-full max-w-[1500px] px-3 pt-2 sm:px-6 sm:pt-4 lg:px-9 lg:pb-4 lg:pt-6 xl:px-11 flex flex-col">
        <MonitorTab
          v-if="visitedTabs.has('monitor')"
          v-show="activeTab === 'monitor'"
          :task="taskState"
          :logs="logs"
          :queue="queue"
          :current-user="currentUser"
          @open-task-modal="handleOpenImportTab"
          @stop-task="handleStopTask"
          @refresh-queue="loadQueue"
          @clear-logs="handleClearLogs"
        />
        <SearchTab
          v-if="visitedTabs.has('search')"
          v-show="activeTab === 'search'"
          :current-user="currentUser"
          :initial-sub-tab="searchSubTab"
          :import-payload="searchImportPayload"
          @task-started="activeTab = 'monitor'; loadQueue();"
          @open-accounts="accountsModalOpen = true"
          @update:initial-sub-tab="searchSubTab = $event"
          @selection-change="activeTab === 'search' && (hasActiveBatchSelection = $event)"
        />
        <PlaylistTab
          v-if="visitedTabs.has('playlists')"
          v-show="activeTab === 'playlists'"
          :current-user="currentUser"
          @selection-change="activeTab === 'playlists' && (hasActiveBatchSelection = $event)"
        />
        <LibraryTab
          v-if="visitedTabs.has('library')"
          v-show="activeTab === 'library'"
          :current-user="currentUser"
          @selection-change="activeTab === 'library' && (hasActiveBatchSelection = $event)"
        />
        <HistoryTab
          v-if="visitedTabs.has('history')"
          v-show="activeTab === 'history'"
          :current-user="currentUser"
          :refresh-key="historyRefreshKey"
          @selection-change="activeTab === 'history' && (hasActiveBatchSelection = $event)"
        />
        <footer class="hidden sm:block shrink-0 py-2 border-t border-border/60 text-[10px] text-muted-foreground/75 text-center">TRIM Music Hub · 连接你的飞牛音乐与 NAS 曲库</footer>
      </main>
    </div>
    <SettingsModal
      :open="settingsModalOpen"
      :is-first-install="isFirstInstall"
      :current-user="currentUser"
      @close="settingsModalOpen = false; isFirstInstall = false;"
      @open-accounts="settingsModalOpen = false; accountsModalOpen = true;"
      @logout="handleLogout"
    />
    <MusicAccountsModal
      :open="accountsModalOpen"
      :current-user="currentUser"
      @close="accountsModalOpen = false"
      @started="activeTab = 'monitor'; loadQueue();"
      @open-import="handleOpenImportFromAccount"
    />
    <LoginModal :open="loginModalOpen" @logged-in="handleLoggedIn" />
    
    <!-- 移动端后台任务微条 (Now Syncing Pill) -->
    <MobileTaskPill
      :task="taskState"
      :visible="activeTab !== 'monitor'"
      :offset-bottom="hasActiveBatchSelection"
      @click="activeTab = 'monitor'"
    />

    <Toast />
  </div>
</template>
