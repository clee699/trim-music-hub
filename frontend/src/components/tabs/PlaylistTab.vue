<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue';
import type { PlaylistSummary, CurrentUser } from '../../types';
import { api, resolveApiUrl } from '../../api';
import { showToast } from '../../composables/useToast';

const props = defineProps<{ currentUser?: CurrentUser | null }>();
const emit = defineEmits<{
  (e: 'selection-change', val: boolean): void;
}>();

import PlaylistTracksModal from '../modals/PlaylistTracksModal.vue';
import BatchActionBar from '@/components/ui/BatchActionBar.vue';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { SpringTabs, type SpringTabItem } from '@/components/ui/tabs';
import { EmptyState, LoadingState, ErrorState } from '@/components/ui/state';
import { ListSentinel, PullRefreshList } from '@/components/ui/list';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from '@/components/ui/dialog';
import {
  ListMusic,
  UserCheck,
  RefreshCw,
  Loader2,
  Edit3,
  Music,
  CalendarDays,
  Search,
  Globe,
  X,
} from 'lucide-vue-next';

const playlists = ref<PlaylistSummary[]>([]);
const systemUsers = ref<Array<{ id: number; name: string; role?: string }>>([]);
const isLoading = ref(false);
const loadError = ref('');
const searchKw = ref('');
const failedCoverKeys = ref<Set<string>>(new Set());

function playlistKey(pl: PlaylistSummary): string {
  return pl.id != null ? `id:${pl.id}` : `name:${pl.name}`;
}

// 批量选择与操作状态（使用唯一 key 隔离同名个人歌单）
const selectedPlaylistKeys = ref<Set<string>>(new Set());
const isBatchDeletingPlaylists = ref(false);
const batchDeletePhysical = ref(false);

watch(() => selectedPlaylistKeys.value.size > 0, (val) => {
  emit('selection-change', val);
});

// 滚动分页控制
const displayLimit = ref(15);

const filteredPlaylists = computed(() => {
  const kw = searchKw.value.trim().toLowerCase();
  if (!kw) return playlists.value;
  return playlists.value.filter(p => {
    const nameMatch = p.name.toLowerCase().includes(kw);
    const userStr = Array.isArray(p.users)
      ? p.users.map(u => u.name).join(',')
      : (typeof p.users === 'string' ? p.users : '');
    const userMatch = userStr.toLowerCase().includes(kw);
    return nameMatch || userMatch;
  });
});

const displayedPlaylists = computed(() => {
  return filteredPlaylists.value.slice(0, displayLimit.value);
});

const hasMore = computed(() => displayLimit.value < filteredPlaylists.value.length);

function loadMore() {
  if (hasMore.value) {
    displayLimit.value += 15;
  }
}

watch(searchKw, () => {
  displayLimit.value = 15;
});

// View & Edit Tracks Dialog (复用通用歌单曲目组件 PlaylistTracksModal)
const tracksDialogOpen = ref(false);
const activePlaylistName = ref('');
const activePlaylist = ref<PlaylistSummary | null>(null);

function handleModalTracksChanged(event: { playlistId?: number; playlistName: string; remainingCount: number }) {
  const pl = playlists.value.find(p =>
    event.playlistId != null ? p.id === event.playlistId : p.name === event.playlistName
  );
  if (pl) {
    pl.track_count = event.remainingCount;
  }
  if (
    activePlaylist.value &&
    (event.playlistId != null
      ? activePlaylist.value.id === event.playlistId
      : activePlaylist.value.name === event.playlistName)
  ) {
    activePlaylist.value.track_count = event.remainingCount;
  }
}

// Edit Playlist Dialog (Name + User Assignment)
const editDialogOpen = ref(false);
const editingPlaylist = ref<PlaylistSummary | null>(null);
const editOldName = ref('');
const editNewName = ref('');
const editVisibilityMode = ref<'public' | 'custom'>('public');
const editSelectedUserIds = ref<number[]>([]);
const isSavingEdit = ref(false);

const visibilityTabs: SpringTabItem<'public' | 'custom'>[] = [
  { value: 'public', label: '公共歌单', icon: Globe },
  { value: 'custom', label: '指定成员', icon: UserCheck },
];

watch(editVisibilityMode, (mode) => {
  if (mode === 'public') {
    editSelectedUserIds.value = systemUsers.value.map(u => u.id);
  } else if (
    editSelectedUserIds.value.length === systemUsers.value.length &&
    systemUsers.value.length > 1
  ) {
    const defaultUid = props.currentUser?.userId || systemUsers.value[0]?.id;
    editSelectedUserIds.value = defaultUid ? [defaultUid] : [];
  } else if (editSelectedUserIds.value.length === 0 && systemUsers.value.length > 0) {
    editSelectedUserIds.value = [systemUsers.value[0].id];
  }
});

async function fetchUsers() {
  try {
    const res = await api.getUsers();
    if (res.ok && res.data) {
      systemUsers.value = res.data;
    }
  } catch (e) {}
}

const isPullRefreshing = ref(false);

async function onPullRefresh() {
  isPullRefreshing.value = true;
  try {
    await fetchPlaylists(true);
  } finally {
    isPullRefreshing.value = false;
  }
}

async function fetchPlaylists(silent = false) {
  if (!silent) {
    isLoading.value = true;
    loadError.value = '';
  }
  try {
    const res = await api.getPlaylists();
    if (res.ok) {
      playlists.value = res.data || [];
      const currentKeys = new Set(playlists.value.map(p => playlistKey(p)));
      selectedPlaylistKeys.value = new Set(
        Array.from(selectedPlaylistKeys.value).filter(key => currentKeys.has(key))
      );
      loadError.value = '';
    } else {
      if (!silent) loadError.value = res.error || '无法读取飞牛歌单';
      showToast('无法读取歌单列表，请稍后重试。', 'error');
    }
  } catch (e: any) {
    if (!silent) loadError.value = e.message || '网络连接异常';
    showToast(`读取歌单失败：${e.message || '网络连接异常'}`, 'error');
  } finally {
    if (!silent) isLoading.value = false;
  }
}

function getPlaylistMembers(users: PlaylistSummary['users']) {
  if (Array.isArray(users)) {
    return users.map(user => user.name).filter(Boolean);
  }
  return (users || '').split(',').map(user => user.trim()).filter(Boolean);
}

function isPublicPlaylist(pl: PlaylistSummary): boolean {
  if (typeof pl.is_public === 'boolean') return pl.is_public;
  if (systemUsers.value.length > 0 && pl.user_ids && pl.user_ids.length > 0) {
    const allUids = systemUsers.value.map(u => u.id);
    if (allUids.every(uid => pl.user_ids?.includes(uid))) {
      return true;
    }
  }
  const members = getPlaylistMembers(pl.users);
  return members.length === 0 || members.some(m => /公共|所有成员/.test(m));
}

function canManagePlaylist(pl: PlaylistSummary): boolean {
  if (!props.currentUser) return false;
  if (props.currentUser.isAdmin) return true;
  if (typeof pl.can_manage === 'boolean') return pl.can_manage;
  return !isPublicPlaylist(pl) && Array.isArray(pl.user_ids) && pl.user_ids.includes(props.currentUser.userId);
}

const manageablePlaylists = computed(() =>
  filteredPlaylists.value.filter(p => canManagePlaylist(p))
);

const isAllPlaylistsSelected = computed(() =>
  manageablePlaylists.value.length > 0 &&
  manageablePlaylists.value.every(p => selectedPlaylistKeys.value.has(playlistKey(p)))
);

function toggleSelectPlaylist(pl: PlaylistSummary) {
  if (!canManagePlaylist(pl)) {
    showToast('无权管理该公共歌单', 'warning');
    return;
  }
  const key = playlistKey(pl);
  const next = new Set(selectedPlaylistKeys.value);
  if (next.has(key)) {
    next.delete(key);
  } else {
    next.add(key);
  }
  selectedPlaylistKeys.value = next;
}

function toggleSelectAllPlaylists() {
  const manageable = manageablePlaylists.value;
  if (manageable.length === 0) return;
  const next = new Set(selectedPlaylistKeys.value);
  if (isAllPlaylistsSelected.value) {
    for (const p of manageable) next.delete(playlistKey(p));
  } else {
    for (const p of manageable) next.add(playlistKey(p));
  }
  selectedPlaylistKeys.value = next;
}

async function handleBatchDeletePlaylists() {
  const targets = playlists.value.filter(p => selectedPlaylistKeys.value.has(playlistKey(p)));
  if (targets.length === 0) return;

  const deletePhysical = Boolean(props.currentUser?.isAdmin && batchDeletePhysical.value);
  isBatchDeletingPlaylists.value = true;
  try {
    const results = await Promise.all(
      targets.map(pl => api.deletePlaylist(pl.name, deletePhysical, pl.id, pl.playlist_ids))
    );
    const succeededKeys = new Set(
      targets.filter((_, idx) => results[idx]?.ok).map(pl => playlistKey(pl))
    );
    const failedCount = targets.length - succeededKeys.size;
    if (succeededKeys.size > 0) {
      playlists.value = playlists.value.filter(p => !succeededKeys.has(playlistKey(p)));
      selectedPlaylistKeys.value = new Set(
        Array.from(selectedPlaylistKeys.value).filter(k => !succeededKeys.has(k))
      );
    }
    if (failedCount === 0) {
      batchDeletePhysical.value = false;
      showToast(`已删除 ${succeededKeys.size} 个歌单${deletePhysical ? '，并清理本地文件' : ''}。`, 'success');
    } else if (succeededKeys.size > 0) {
      showToast(`已删除 ${succeededKeys.size} 个歌单，${failedCount} 个失败。`, 'warning');
    } else {
      const firstErr = results.find(r => !r.ok)?.error || '删除歌单失败';
      showToast(firstErr, 'error');
    }
  } catch (e: any) {
    showToast(`批量删除歌单失败: ${e.message}`, 'error');
  } finally {
    isBatchDeletingPlaylists.value = false;
  }
}

function formatMemberSummary(pl: PlaylistSummary) {
  if (isPublicPlaylist(pl)) {
    return '公共歌单 (全部成员)';
  }
  const members = getPlaylistMembers(pl.users);
  return `专属 · ${members.join(', ')}`;
}

function formatPlaylistDate(value?: string) {
  if (!value) return '创建时间未知';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '创建时间未知';
  return date.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
}

type CoverType = 'playlist' | 'track';

function coverUrl(type: CoverType, guid?: string) {
  return guid ? resolveApiUrl(`/api/covers/${type}/${encodeURIComponent(guid)}?size=160`) : '';
}

function coverAvailable(type: CoverType, guid?: string) {
  return Boolean(guid) && !failedCoverKeys.value.has(`${type}:${guid}`);
}

function markCoverFailed(type: CoverType, guid?: string) {
  const next = new Set(failedCoverKeys.value);
  next.add(`${type}:${guid || ''}`);
  failedCoverKeys.value = next;
}

function viewTracks(pl: PlaylistSummary) {
  if (selectedPlaylistKeys.value.size > 0) return;
  activePlaylist.value = pl;
  activePlaylistName.value = pl.name;
  tracksDialogOpen.value = true;
}

function openEdit(pl: PlaylistSummary) {
  if (selectedPlaylistKeys.value.size > 0) return;
  editingPlaylist.value = pl;
  editOldName.value = pl.name;
  editNewName.value = pl.name;

  const allUids = systemUsers.value.map(u => u.id);
  const currentUids = pl.user_ids || [];

  const isPub = isPublicPlaylist(pl);
  if (isPub) {
    editSelectedUserIds.value = [...allUids];
    editVisibilityMode.value = 'public';
  } else {
    editSelectedUserIds.value = currentUids.length > 0 ? [...currentUids] : (allUids[0] ? [allUids[0]] : []);
    editVisibilityMode.value = 'custom';
  }

  editDialogOpen.value = true;
}

function toggleEditUserId(uid: number) {
  const s = new Set(editSelectedUserIds.value);
  if (s.has(uid)) {
    s.delete(uid);
  } else {
    s.add(uid);
  }
  editSelectedUserIds.value = Array.from(s);
  if (systemUsers.value.length > 0 && editSelectedUserIds.value.length === systemUsers.value.length) {
    editVisibilityMode.value = 'public';
  } else {
    editVisibilityMode.value = 'custom';
  }
}

async function handleSaveEdit() {
  const newName = editNewName.value.trim();
  if (!newName) {
    showToast('歌单名称不能为空', 'error');
    return;
  }

  const pl = editingPlaylist.value;
  const isAdmin = Boolean(props.currentUser?.isAdmin);
  const targetUids = editVisibilityMode.value === 'public'
    ? systemUsers.value.map(u => u.id)
    : editSelectedUserIds.value;

  if (isAdmin && targetUids.length === 0) {
    showToast('请至少选择一个可见成员', 'warning');
    return;
  }

  isSavingEdit.value = true;
  try {
    let effectiveName = editOldName.value;
    if (newName !== editOldName.value) {
      const resRename = await api.renamePlaylist(editOldName.value, newName, pl?.id, pl?.playlist_ids);
      if (!resRename.ok) {
        showToast(resRename.error || '重命名失败', 'error');
        return;
      }
      effectiveName = newName;
    }

    if (isAdmin) {
      const resUsers = await api.updatePlaylistUsers(effectiveName, targetUids, pl?.id, pl?.playlist_ids);
      if (!resUsers.ok) {
        showToast(resUsers.error || '更新歌单可见成员失败', 'error');
        return;
      }
    }

    showToast(`“${effectiveName}”已保存。`, 'success');
    editDialogOpen.value = false;
    await fetchPlaylists();
  } catch (e: any) {
    showToast(`保存失败：${e.message}`, 'error');
  } finally {
    isSavingEdit.value = false;
  }
}

onMounted(async () => {
  await fetchUsers();
  await fetchPlaylists();
});
</script>

<template>
  <div class="tab-content-container space-y-3">
    <!-- Top Control Bar (固定顶部，绝不随列表滚动) -->
    <Card class="bg-card/80 border-border backdrop-blur-xl shadow-xl p-3 sm:p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 shrink-0 z-10">
      <div class="flex items-center gap-2.5 text-xs">
        <span class="text-foreground/85 font-medium flex items-center gap-1.5">
          <ListMusic class="w-4 h-4 text-primary" />
          <span>歌单</span>
          <strong class="text-foreground font-mono text-sm">{{ playlists.length }}</strong> 个
        </span>
        <span class="text-muted-foreground/75">|</span>
        <span class="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span class="h-1.5 w-1.5 rounded-full bg-success shadow-[0_0_6px_hsl(var(--success)/0.6)]" />
          已连接飞牛音乐
        </span>
      </div>

      <div class="flex items-center gap-2 w-full sm:w-auto">
        <div class="relative flex-1 sm:w-64">
          <Search class="w-3.5 h-3.5 text-muted-foreground absolute left-3 top-1/2 -translate-y-1/2 z-10" />
          <Input
            v-model="searchKw"
            type="text"
            placeholder="搜索歌单或成员"
            class="pl-9 pr-8 h-9 text-xs"
          />
          <Button
            v-if="searchKw"
            type="button"
            variant="ghost"
            size="iconSm"
            @click="searchKw = ''"
            class="absolute right-1.5 top-1/2 -translate-y-1/2 h-6 w-6 text-muted-foreground hover:text-foreground rounded-full"
            title="清空"
          >
            <X class="w-3.5 h-3.5" />
          </Button>
        </div>

        <Button
          variant="outline"
          size="icon"
          @click="fetchPlaylists()"
          title="刷新歌单列表"
          class="h-9 w-9 rounded-xl shrink-0"
        >
          <RefreshCw class="w-4 h-4" :class="{ 'animate-spin': isLoading }" />
        </Button>
      </div>
    </Card>

    <!-- 固定的列表头部栏（全选 / 统计，固定于列表上方不随列表滚动） -->
    <div v-if="filteredPlaylists.length > 0" class="flex items-center justify-between px-1 text-xs shrink-0">
      <div class="flex items-center gap-2">
        <template v-if="manageablePlaylists.length > 0">
          <Button
            variant="ghost"
            size="sm"
            class="h-7 px-2 text-muted-foreground text-[11px] sm:text-xs"
            @click="toggleSelectAllPlaylists"
          >
            {{ isAllPlaylistsSelected ? '取消全选' : '全选' }}
          </Button>
          <span class="text-muted-foreground/50">|</span>
        </template>
        <span class="text-muted-foreground text-[11px] sm:text-xs">
          共 <strong class="text-foreground font-mono">{{ filteredPlaylists.length }}</strong> 个歌单
        </span>
        <span v-if="selectedPlaylistKeys.size > 0" class="text-warning font-medium text-[11px] sm:text-xs">
          · 已选 {{ selectedPlaylistKeys.size }} 个
        </span>
      </div>
    </div>

    <!-- 只有列表滚动，内置下拉刷新组件 -->
    <PullRefreshList
      :refreshing="isPullRefreshing"
      @refresh="onPullRefresh"
      class="custom-scrollbar pr-0.5"
    >
      <section class="space-y-3 pb-6">
      <LoadingState
        v-if="isLoading && playlists.length === 0"
        title="正在读取歌单…"
        description="连接飞牛数据库与 M3U 播放列表"
      />

      <ErrorState
        v-else-if="loadError"
        title="歌单列表获取失败"
        :description="loadError"
        retry-text="重新加载"
        @retry="fetchPlaylists()"
      />

      <EmptyState
        v-else-if="playlists.length === 0"
        :icon="ListMusic"
        title="还没有歌单"
        description="先导入一个第三方歌单，或使用上方导入功能。"
      />

      <EmptyState
        v-else-if="filteredPlaylists.length === 0"
        :icon="Search"
        :title="`未找到与 “${searchKw}” 匹配的歌单`"
        action-text="清空搜索"
        @action="searchKw = ''"
      />

      <!-- 可滚动歌单平铺列表 -->
      <div
        v-else
        class="space-y-2 select-text"
      >
        <article
          v-for="pl in displayedPlaylists"
          :key="playlistKey(pl)"
          :class="[
            'media-list-row media-list-row--playlist transition-all',
            { 'media-list-row--selected': selectedPlaylistKeys.has(playlistKey(pl)) }
          ]"
          :role="canManagePlaylist(pl) ? 'button' : undefined"
          :tabindex="canManagePlaylist(pl) ? 0 : undefined"
          :aria-pressed="canManagePlaylist(pl) ? selectedPlaylistKeys.has(playlistKey(pl)) : undefined"
          :aria-label="canManagePlaylist(pl) ? `${selectedPlaylistKeys.has(playlistKey(pl)) ? '取消选择' : '选择'}歌单 ${pl.name}` : undefined"
          @click="canManagePlaylist(pl) ? toggleSelectPlaylist(pl) : viewTracks(pl)"
          @keydown.enter.prevent="canManagePlaylist(pl) ? toggleSelectPlaylist(pl) : viewTracks(pl)"
          @keydown.space.prevent="canManagePlaylist(pl) ? toggleSelectPlaylist(pl) : viewTracks(pl)"
        >
          <div class="media-list-row__art" aria-hidden="true">
            <img
              v-if="coverAvailable('playlist', pl.cover_guid)"
              :src="coverUrl('playlist', pl.cover_guid)"
              :alt="`${pl.name} 封面`"
              loading="lazy"
              decoding="async"
              @error="markCoverFailed('playlist', pl.cover_guid)"
            />
            <div v-else class="media-list-row__art-fallback">
              <ListMusic class="h-6 w-6 text-primary/35" />
            </div>
          </div>

          <div class="media-list-row__content">
            <div class="media-list-row__title-line">
              <strong class="media-list-row__title">{{ pl.name }}</strong>
              <Badge :variant="pl.m3u_exists ? 'success' : 'outline'" class="shrink-0">
                {{ pl.m3u_exists ? '已同步' : '待生成 M3U' }}
              </Badge>
            </div>
            <p class="media-list-row__subtitle" :title="formatMemberSummary(pl)">
              {{ isPublicPlaylist(pl) ? '所有家庭成员可见' : formatMemberSummary(pl) }}
            </p>
            <div class="media-list-row__meta">
              <span class="flex items-center gap-1"><Music class="h-3 w-3" />{{ pl.track_count }} 首</span>
              <span class="flex items-center gap-1"><CalendarDays class="h-3 w-3" />{{ formatPlaylistDate(pl.updated_at || pl.created_at) }}</span>
              <span class="hidden items-center gap-1 sm:flex"><Globe v-if="isPublicPlaylist(pl)" class="h-3 w-3" /><UserCheck v-else class="h-3 w-3" />{{ isPublicPlaylist(pl) ? '公共歌单' : '指定成员' }}</span>
            </div>
          </div>

          <!-- 末尾操作工具栏：未处于多选时显示详情与编辑；进入多选时切换为勾选状态，杜绝交互冲突 -->
          <div
            v-if="selectedPlaylistKeys.size > 0 && canManagePlaylist(pl)"
            class="media-list-row__playlist-tools pointer-events-none pr-1"
          >
            <Checkbox
              :checked="selectedPlaylistKeys.has(playlistKey(pl))"
              tabindex="-1"
              class="pointer-events-none"
            />
          </div>
          <div
            v-else-if="selectedPlaylistKeys.size === 0"
            class="media-list-row__playlist-tools"
            @click.stop
          >
            <Button
              variant="ghost"
              size="iconSm"
              title="查看歌单曲目与详情"
              class="text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors"
              @click="viewTracks(pl)"
            >
              <ListMusic class="h-4 w-4" />
            </Button>
            <Button
              v-if="canManagePlaylist(pl)"
              variant="ghost"
              size="iconSm"
              title="编辑歌单"
              class="text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              @click="openEdit(pl)"
            >
              <Edit3 class="h-3.5 w-3.5" />
            </Button>
          </div>
        </article>

        <!-- 滚动触底 Sentinel 哨兵组件 -->
        <ListSentinel
          :has-more="hasMore"
          :loading="isLoading"
          :total="filteredPlaylists.length"
          unit="个歌单"
          loading-text="正在加载更多歌单…"
          @load-more="loadMore"
        />
      </div>
    </section>
    </PullRefreshList>

    <!-- 底部浮动批量操作栏（歌单管理） -->
    <BatchActionBar
      :show="selectedPlaylistKeys.size > 0"
      :count="selectedPlaylistKeys.size"
      unit="个歌单"
      action-text="彻底删除"
      confirm-title="彻底删除选中的歌单？"
      confirm-desc="歌单将从飞牛音乐中移除。"
      :loading="isBatchDeletingPlaylists"
      @cancel="selectedPlaylistKeys = new Set()"
      @confirm="handleBatchDeletePlaylists"
    >
      <template #extra>
        <label v-if="currentUser?.isAdmin" class="mt-2 flex cursor-pointer select-none items-center gap-2.5 rounded-xl border border-destructive/25 bg-destructive/10 p-2 text-[11px] text-destructive">
          <Checkbox v-model="batchDeletePhysical" />
          <span>同时删除歌单中的本地歌曲和歌词</span>
        </label>
      </template>
    </BatchActionBar>

    <!-- Dialog: View & Edit Tracks (通用歌单曲目管理组件) -->
    <PlaylistTracksModal
      v-model:open="tracksDialogOpen"
      :playlist-name="activePlaylistName"
      :playlist-summary="activePlaylist"
      :current-user="currentUser"
      @tracks-changed="handleModalTracksChanged"
    />

    <!-- Dialog: Edit Playlist (支持修改歌单名与指定用户分配) -->
    <Dialog :open="editDialogOpen" @update:open="(val: boolean) => editDialogOpen = val">
      <DialogContent class="sm:max-w-md bg-popover border border-border backdrop-blur-2xl shadow-2xl rounded-2xl p-6 space-y-4">
        <DialogHeader>
          <DialogTitle class="text-base font-bold text-foreground flex items-center gap-2">
            <Edit3 class="w-4 h-4 text-primary" />
            <span>编辑歌单</span>
          </DialogTitle>
          <DialogDescription class="text-xs text-muted-foreground">
            {{ currentUser?.isAdmin ? '修改歌单名称和可见成员。' : '修改歌单名称。' }}
          </DialogDescription>
        </DialogHeader>

        <div class="space-y-4 py-1">
          <!-- 歌单名称 -->
          <div class="space-y-1.5">
            <label class="text-xs font-medium text-foreground">歌单名称</label>
            <Input
              v-model="editNewName"
              placeholder="输入歌单名称"
              class="h-9 text-xs"
            />
          </div>

          <!-- 可见范围设置 (仅管理员可见，使用物理惯性弹簧切换器) -->
          <div v-if="currentUser?.isAdmin" class="space-y-2.5">
            <label class="text-xs font-medium text-foreground">可见范围</label>
            <SpringTabs
              v-model="editVisibilityMode"
              :items="visibilityTabs"
              full-width
            />

            <!-- 成员勾选列表 -->
            <div
              v-if="editVisibilityMode === 'custom' && systemUsers.length > 0"
              class="space-y-1 pt-1.5 max-h-40 overflow-y-auto custom-scrollbar pr-1"
            >
              <label
                v-for="u in systemUsers"
                :key="u.id"
                class="flex items-center justify-between p-2 rounded-lg hover:bg-muted/60 cursor-pointer text-xs select-none"
              >
                <div class="flex items-center gap-2">
                  <UserCheck class="w-3.5 h-3.5 text-muted-foreground" />
                  <span>{{ u.name }}</span>
                  <Badge v-if="u.role === 'admin'" variant="secondary" class="text-[9px] px-1 py-0">管理员</Badge>
                </div>
                <Checkbox
                  :checked="editSelectedUserIds.includes(u.id)"
                  @update:checked="toggleEditUserId(u.id)"
                />
              </label>
            </div>
          </div>
        </div>

        <DialogFooter class="gap-2 sm:gap-0">
          <Button variant="ghost" size="sm" @click="editDialogOpen = false" class="text-xs">取消</Button>
          <Button size="sm" :disabled="isSavingEdit" @click="handleSaveEdit" class="text-xs gap-1.5">
            <Loader2 v-if="isSavingEdit" class="w-3.5 h-3.5 animate-spin" />
            <span>保存变更</span>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
