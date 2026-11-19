<script setup lang="ts">
import { ref, watch, computed } from 'vue';
import { api } from '../../api';
import { showToast } from '../../composables/useToast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Popconfirm } from '@/components/ui/popconfirm';
import { SpringTabs, type SpringTabItem } from '@/components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from '@/components/ui/dialog';
import {
  Settings,
  Check,
  Sparkles,
  Loader2,
  Sliders,
  Server,
  Key,
  Link2,
  FolderCheck,
  FolderOpen,
  AlertTriangle,
  RefreshCw,
  FolderPlus,
  ChevronRight,
  ChevronLeft,
  UserRound,
  ShieldCheck,
  UserCheck,
  LogOut,
  Layers,
  Cpu
} from 'lucide-vue-next';
import type { SettingsData, AuthorizedDirectory, CurrentUser } from '../../types';

const props = defineProps<{
  open: boolean;
  isFirstInstall?: boolean;
  currentUser?: CurrentUser | null;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'update:open', val: boolean): void;
  (e: 'updated', source: string, dir: string): void;
  (e: 'open-accounts'): void;
  (e: 'logout'): void;
}>();

type SettingsLevel = 'root' | 'directory' | 'source' | 'concurrency' | 'transcode' | 'about';
const currentLevel = ref<SettingsLevel>('root');
const transitionName = ref<'slide-left' | 'slide-right'>('slide-left');

function navigateTo(level: SettingsLevel) {
  transitionName.value = 'slide-left';
  currentLevel.value = level;
}

function navigateBack() {
  transitionName.value = 'slide-right';
  currentLevel.value = 'root';
}

function openAccountsModal() {
  emit('open-accounts');
}

const currentSource = ref<'kw' | 'kg' | 'tx' | 'wy' | 'auto' | 'custom'>('kw');
const concurrentDownloads = ref<number>(5);
const forceTranscode = ref<boolean>(false);
const transcodeQuality = ref<'flac' | '320k' | '128k'>('320k');
const downloadDir = ref<string>('');
const originalDownloadDir = ref<string>('');
const authorizedDirs = ref<AuthorizedDirectory[]>([]);
const isLoadingDirs = ref<boolean>(false);
const customDirInput = ref<string>('');
const dirVerifyResult = ref<{
  ok: boolean;
  exists: boolean;
  writable: boolean;
  is_fnos_authorized: boolean;
  error: string | null;
} | null>(null);
const isVerifyingDir = ref<boolean>(false);
const isTaskRunning = ref<boolean>(false);

const concurrencyPresetTabs: SpringTabItem<number>[] = [
  { value: 1, label: '1 首' },
  { value: 3, label: '3 首' },
  { value: 5, label: '5 首 · 推荐' },
  { value: 8, label: '8 首' },
  { value: 10, label: '10 首' },
];

type TranscodeMode = 'passthrough' | 'transcode';
const transcodeModeTabs: SpringTabItem<TranscodeMode>[] = [
  { value: 'passthrough', label: '直通免转码' },
  { value: 'transcode', label: '向下转码' },
];
const transcodeMode = computed<TranscodeMode>({
  get: () => (forceTranscode.value ? 'transcode' : 'passthrough'),
  set: (val) => {
    const next = val === 'transcode';
    if (next !== forceTranscode.value) {
      toggleForceTranscode(next);
    }
  },
});

async function checkTaskRunning() {
  try {
    const [statusRes, queueRes] = await Promise.all([
      api.getStatus(),
      api.getTaskQueue()
    ]);
    const currentRunning = statusRes.ok && Boolean(statusRes.isRunning);
    const queueActive = queueRes.ok && Array.isArray(queueRes.data) && queueRes.data.some((t: any) => t.status === 'running' || t.status === 'pending');
    isTaskRunning.value = Boolean(currentRunning || queueActive);
  } catch {
    isTaskRunning.value = false;
  }
}

const availableSources = ref<SettingsData['available_sources']>([
  { id: 'kw', name: '酷我音乐', desc: '高品质FLAC专线 · 推荐默认', default: true },
  { id: 'kg', name: '酷狗音乐', desc: '海棠/星海SVIP线路', default: false },
  { id: 'tx', name: 'QQ音乐', desc: '长青/溯音专线', default: false },
  { id: 'wy', name: '网易云音乐', desc: '163云音乐线路', default: false },
  { id: 'auto', name: '智能多源聚合', desc: '酷我优先，故障自动回退', default: false },
  { id: 'custom', name: '自定义音源', desc: '自建 API 端点 / 远程源脚本解析', default: false }
]);

const customConfig = ref({
  name: '自建音乐解析服务',
  api_url: '',
  api_key: '',
  script_url: ''
});

const isSaving = ref(false);

async function loadDirectories() {
  if (!props.currentUser?.isAdmin) return;
  isLoadingDirs.value = true;
  try {
    const res = await api.getAuthorizedDirectories();
    if (res.ok && res.data) {
      authorizedDirs.value = res.data;
    }
  } catch (e) {
    console.error('Failed to load authorized directories:', e);
  } finally {
    isLoadingDirs.value = false;
  }
}

async function verifyCustomDirectory(targetPath: string) {
  if (!props.currentUser?.isAdmin) return;
  if (!targetPath.trim()) {
    dirVerifyResult.value = null;
    return;
  }
  isVerifyingDir.value = true;
  try {
    const res = await api.verifyDirectory(targetPath.trim());
    if (res.ok && res.data) {
      dirVerifyResult.value = res.data;
      if (res.data.ok) {
        downloadDir.value = res.data.path;
      }
    } else {
      dirVerifyResult.value = {
        ok: false,
        exists: false,
        writable: false,
        is_fnos_authorized: false,
        error: '目录验证请求失败'
      };
    }
  } catch (e: any) {
    dirVerifyResult.value = {
      ok: false,
      exists: false,
      writable: false,
      is_fnos_authorized: false,
      error: e.message
    };
  } finally {
    isVerifyingDir.value = false;
  }
}

function selectDirectory(d: AuthorizedDirectory) {
  downloadDir.value = d.path;
  customDirInput.value = d.path;
  dirVerifyResult.value = {
    ok: d.writable,
    exists: d.exists,
    writable: d.writable,
    is_fnos_authorized: d.is_fnos_authorized,
    error: d.writable ? null : '该目录不可写'
  };
}

async function loadSettings() {
  try {
    await Promise.all([
      props.currentUser?.isAdmin ? loadDirectories() : Promise.resolve(),
      checkTaskRunning()
    ]);
    const res = await api.getSettings();
    if (res.ok && res.data) {
      currentSource.value = res.data.download_source || 'kw';
      concurrentDownloads.value = res.data.concurrent_downloads || 5;
      forceTranscode.value = Boolean(res.data.force_transcode);
      if (res.data.transcode_quality && ['flac', '320k', '128k'].includes(res.data.transcode_quality)) {
        transcodeQuality.value = res.data.transcode_quality as any;
      }
      downloadDir.value = res.data.download_dir || '';
      originalDownloadDir.value = downloadDir.value;
      customDirInput.value = downloadDir.value;

      if (props.currentUser?.isAdmin && !downloadDir.value && authorizedDirs.value.length > 0) {
        const defaultWritable = authorizedDirs.value.find(d => d.writable && d.is_fnos_authorized) || authorizedDirs.value.find(d => d.writable);
        if (defaultWritable) {
          selectDirectory(defaultWritable);
        }
      }

      if (res.data.available_sources) {
        availableSources.value = res.data.available_sources;
      }
      if (res.data.custom_source) {
        customConfig.value = {
          name: res.data.custom_source.name || '自建音乐解析服务',
          api_url: res.data.custom_source.api_url || '',
          api_key: res.data.custom_source.api_key || '',
          script_url: res.data.custom_source.script_url || ''
        };
      }

      if (props.currentUser?.isAdmin && downloadDir.value) {
        verifyCustomDirectory(downloadDir.value);
      }
    }
  } catch (e) {}
}

async function handleSave() {
  if (!props.currentUser?.isAdmin) {
    showToast('无法修改系统设置', 'error');
    return;
  }

  const nextDir = downloadDir.value.trim();
  const isChangingDir = nextDir !== originalDownloadDir.value;
  if (isTaskRunning.value && isChangingDir) {
    showToast('当前有任务正在执行或排队中，暂无法切换保存目录', 'warning');
    return;
  }

  if (!nextDir) {
    showToast('请先选择一个可用的音乐保存目录。', 'warning');
    navigateTo('directory');
    return;
  }

  if (dirVerifyResult.value && !dirVerifyResult.value.writable) {
    showToast('当前目录不可写，请检查权限或选择其他目录。', 'error');
    navigateTo('directory');
    return;
  }

  if (currentSource.value === 'custom' && !customConfig.value.api_url.trim() && !customConfig.value.script_url.trim()) {
    showToast('使用自定义音源时，请填写 API 地址或源脚本地址。', 'warning');
    navigateTo('source');
    return;
  }

  const clampedConcurrency = Math.min(10, Math.max(1, Number(concurrentDownloads.value) || 5));
  concurrentDownloads.value = clampedConcurrency;

  isSaving.value = true;
  try {
    const res = await api.updateSettings(
      currentSource.value,
      customConfig.value,
      isChangingDir ? nextDir : undefined,
      true,
      clampedConcurrency,
      forceTranscode.value,
      transcodeQuality.value
    );
    if (res.ok) {
      originalDownloadDir.value = nextDir;
      showToast('设置已保存。', 'success');
      emit('updated', currentSource.value, nextDir);
      if (props.isFirstInstall) {
        handleOpenUpdate(false);
      } else {
        navigateBack();
      }
    } else {
      showToast(res.error || '设置保存失败', 'error');
    }
  } catch (e: any) {
    showToast(`保存失败： ${e.message}`, 'error');
  } finally {
    isSaving.value = false;
  }
}

function handleOpenUpdate(val: boolean) {
  emit('update:open', val);
  if (!val) emit('close');
}

watch(() => props.open, (val) => {
  if (val) {
    if (props.isFirstInstall && props.currentUser?.isAdmin) {
      currentLevel.value = 'directory';
    } else {
      currentLevel.value = 'root';
    }
    loadSettings();
  }
}, { immediate: true });

const selectedSource = computed(() =>
  availableSources.value.find(source => source.id === currentSource.value)
);

const selectedSourceName = computed(() =>
  selectedSource.value?.name || currentSource.value.toUpperCase()
);

const selectedSourceDesc = computed(() =>
  selectedSource.value?.desc || '在线音源解析服务'
);

const compactDownloadDir = computed(() => {
  const path = downloadDir.value.trim();
  if (!path) return '';
  return path.split(/[\\/]/).filter(Boolean).at(-1) || path;
});

const transcodeQualityOptions = [
  {
    id: 'flac' as const,
    name: 'FLAC 无损格式',
    badge: '标准无损',
    desc: '仅当下载源为 Hi-Res (24-bit) 等母带音源时转为标准 FLAC；若下载源为 MP3 (320K/128K) 则自动跳过转码'
  },
  {
    id: '320k' as const,
    name: 'MP3 · 320K 高品质',
    badge: '通用推荐',
    desc: '当下载源为 FLAC 无损时向下转码为 320K MP3；若下载源已是 320K 或 128K MP3 则自动跳过转码'
  },
  {
    id: '128k' as const,
    name: 'MP3 · 128K 标准音质',
    badge: '极致省流',
    desc: '当下载源为 FLAC 或 320K MP3 时向下转码为 128K MP3；若已是 128K 则自动跳过转码'
  }
];

const transcodeQualityLabel = computed(() => {
  switch (transcodeQuality.value) {
    case 'flac': return 'FLAC 无损';
    case '320k': return 'MP3 320K';
    case '128k': return 'MP3 128K';
    default: return 'MP3 320K';
  }
});

async function toggleForceTranscode(val: boolean) {
  if (!props.currentUser?.isAdmin) return;
  forceTranscode.value = val;
  try {
    const res = await api.updateSettings(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      val,
      transcodeQuality.value
    );
    if (res.ok) {
      showToast(val ? `已开启强制音频转码（目标格式: ${transcodeQualityLabel.value}）` : '已关闭强制转码，启用原生直通免转码模式', 'success');
    }
  } catch (e: any) {
    showToast(`切换转码模式失败：${e.message}`, 'error');
  }
}

async function selectTranscodeQuality(quality: 'flac' | '320k' | '128k') {
  if (!props.currentUser?.isAdmin) return;
  transcodeQuality.value = quality;
  try {
    const res = await api.updateSettings(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      forceTranscode.value,
      quality
    );
    if (res.ok) {
      showToast(`已设置目标转码品质为: ${transcodeQualityLabel.value}`, 'success');
    }
  } catch (e: any) {
    showToast(`设置转码品质失败：${e.message}`, 'error');
  }
}

const pageTitle = computed(() => {
  switch (currentLevel.value) {
    case 'directory': return '保存位置';
    case 'source': return '下载音源';
    case 'concurrency': return '并发下载设置';
    case 'transcode': return '音频转码策略';
    case 'about': return '系统状态';
    default: return props.isFirstInstall ? '开始前设置' : '设置';
  }
});

const pageSubtitle = computed(() => {
  switch (currentLevel.value) {
    case 'directory': return '管理新下载歌曲、歌词与封面的存储位置';
    case 'source': return '切换或配置在线音乐解析与下载线路';
    case 'concurrency': return '调整歌单同步时多首歌同时下载的线程数';
    case 'transcode': return '配置下载音频的原生直通或向下转码策略';
    case 'about': return 'TRIM Music Hub 服务底座与存储状态';
    default: return '管理音乐平台绑定、系统参数与运行状态';
  }
});
</script>

<template>
  <Dialog :open="props.open" @update:open="handleOpenUpdate">
    <DialogContent
      class="!inset-x-0 !bottom-0 !top-4 !h-[calc(100dvh-1rem)] !max-h-[calc(100dvh-1rem)] !grid-rows-[auto_minmax(0,1fr)_auto] !gap-0 !overflow-hidden !rounded-b-none !rounded-t-[1.75rem] !border-b-0 !p-0 shadow-[0_-18px_70px_hsl(var(--shadow-color)/.3)] sm:!left-1/2 sm:!top-1/2 sm:!bottom-auto sm:!h-[min(88dvh,720px)] sm:!max-h-[min(88dvh,720px)] sm:!max-w-xl sm:!-translate-x-1/2 sm:!-translate-y-1/2 sm:!rounded-[1.4rem] sm:!border-b sm:shadow-[0_30px_90px_hsl(var(--shadow-color)/.3)]"
    >
      <!-- 顶部 Header（支持返回上级菜单） -->
      <DialogHeader class="shrink-0 border-b border-border/80 px-4 pb-3.5 pr-12 pt-4 text-left sm:px-6 sm:pb-4 sm:pt-5">
        <div class="flex items-center gap-2.5">
          <!-- 二级菜单：返回上级按钮 -->
          <Button
            v-if="currentLevel !== 'root' && !props.isFirstInstall"
            variant="ghost"
            size="sm"
            class="-ml-2 h-9 gap-1 rounded-xl px-2 text-xs font-semibold text-primary hover:bg-primary/10 hover:text-primary active:scale-95 transition-all"
            @click="navigateBack"
          >
            <ChevronLeft class="h-4 w-4 stroke-[2.5]" />
            <span>设置</span>
          </Button>

          <!-- 一级菜单图标 -->
          <div
            v-else
            class="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary"
          >
            <Settings class="h-4 w-4" />
          </div>

          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <DialogTitle class="text-[16px] font-bold tracking-tight text-foreground truncate">
                {{ pageTitle }}
              </DialogTitle>
              <Badge v-if="props.isFirstInstall" variant="brand" class="h-5 px-1.5 text-[9px]">首次引导</Badge>
            </div>
            <DialogDescription class="mt-0.5 truncate text-[11px] text-muted-foreground">
              {{ pageSubtitle }}
            </DialogDescription>
          </div>
        </div>
      </DialogHeader>

      <!-- 动态层级视图区（滚动列表 + 平滑过渡） -->
      <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain custom-scrollbar px-4 py-4 sm:px-6 sm:py-5">
        <Transition :name="transitionName" mode="out-in">
          <!-- 1. 一级设置列表 (Root Level) -->
          <div v-if="currentLevel === 'root'" key="root" class="space-y-4">
            <!-- 分组 0: 当前登录账号身份卡片 -->
            <div v-if="props.currentUser" class="rounded-2xl border border-border/80 bg-card p-3.5 sm:p-4 shadow-sm">
              <div class="flex items-center justify-between gap-3">
                <div class="flex items-center gap-3 min-w-0">
                  <div class="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary/15 text-primary">
                    <UserCheck class="h-5 w-5" />
                  </div>
                  <div class="min-w-0">
                    <div class="flex items-center gap-2">
                      <span class="text-sm font-bold text-foreground truncate">{{ props.currentUser.username }}</span>
                      <Badge :variant="props.currentUser.isAdmin ? 'brand' : 'secondary'" class="text-[10px] px-2 py-0.5">
                        {{ props.currentUser.isAdmin ? '管理员' : '成员' }}
                      </Badge>
                    </div>
                    <p class="mt-0.5 text-[11px] text-muted-foreground truncate">
                      已连接飞牛系统账号
                    </p>
                  </div>
                </div>
                <Popconfirm
                  title="确认退出当前账号？"
                  description="退出后需要重新输入飞牛账号和密码登录"
                  confirm-text="退出登录"
                  @confirm="emit('logout')"
                >
                  <Button variant="ghost" size="sm" class="h-8 gap-1 px-2.5 text-xs text-muted-foreground hover:text-destructive active:scale-95">
                    <LogOut class="h-3.5 w-3.5" />
                    <span class="hidden sm:inline">退出</span>
                  </Button>
                </Popconfirm>
              </div>
            </div>
            <!-- 分组 1: 核心下载与存储 -->
            <div v-if="props.currentUser?.isAdmin">
              <div class="px-1 mb-1.5 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                核心偏好
              </div>
              <div class="rounded-2xl border border-border/80 bg-card overflow-hidden divide-y divide-border/60 shadow-sm">
                <Button
                  type="button"
                  variant="ghost"
                  class="w-full h-auto rounded-none flex items-center justify-between p-3.5 sm:p-4 text-left hover:bg-muted/40 active:bg-muted/60"
                  @click="navigateTo('directory')"
                >
                  <div class="flex items-center gap-3.5 min-w-0 pr-2">
                    <div class="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-emerald-500/10 text-emerald-500">
                      <FolderCheck class="h-5 w-5" />
                    </div>
                    <div class="min-w-0">
                      <div class="flex items-center gap-2">
                        <span class="text-sm font-bold text-foreground">保存位置</span>
                        <Badge v-if="compactDownloadDir" variant="success" class="px-2 py-0.5 text-[10px]">
                          {{ compactDownloadDir }}
                        </Badge>
                      </div>
                      <p class="mt-0.5 truncate font-mono text-[11px] text-muted-foreground font-normal">
                        {{ downloadDir || '尚未配置保存目录' }}
                      </p>
                    </div>
                  </div>
                  <div class="flex items-center gap-1.5 shrink-0 text-muted-foreground">
                    <span v-if="dirVerifyResult?.writable" class="hidden sm:inline-block text-[11px] text-success font-medium">可写</span>
                    <ChevronRight class="h-4 w-4 opacity-60" />
                  </div>
                </Button>

                <Button
                  type="button"
                  variant="ghost"
                  class="w-full h-auto rounded-none flex items-center justify-between p-3.5 sm:p-4 text-left hover:bg-muted/40 active:bg-muted/60"
                  @click="navigateTo('source')"
                >
                  <div class="flex items-center gap-3.5 min-w-0 pr-2">
                    <div class="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-violet-500/10 text-violet-500">
                      <Sparkles class="h-5 w-5" />
                    </div>
                    <div class="min-w-0">
                      <div class="flex items-center gap-2">
                        <span class="text-sm font-bold text-foreground">下载音源</span>
                        <Badge variant="brand" class="px-2 py-0.5 text-[10px]">
                          {{ selectedSourceName }}
                        </Badge>
                      </div>
                      <p class="mt-0.5 truncate text-[11px] text-muted-foreground font-normal">
                        {{ selectedSourceDesc }}
                      </p>
                    </div>
                  </div>
                  <div class="flex items-center gap-1.5 shrink-0 text-muted-foreground">
                    <ChevronRight class="h-4 w-4 opacity-60" />
                  </div>
                </Button>

                <Button
                  type="button"
                  variant="ghost"
                  class="w-full h-auto rounded-none flex items-center justify-between p-3.5 sm:p-4 text-left hover:bg-muted/40 active:bg-muted/60"
                  @click="navigateTo('concurrency')"
                >
                  <div class="flex items-center gap-3.5 min-w-0 pr-2">
                    <div class="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-amber-500/10 text-amber-500">
                      <Layers class="h-5 w-5" />
                    </div>
                    <div class="min-w-0">
                      <div class="flex items-center gap-2">
                        <span class="text-sm font-bold text-foreground">同时下载歌曲数</span>
                        <Badge variant="warning" class="px-2 py-0.5 text-[10px] font-mono">
                          {{ concurrentDownloads }} 首同时下载
                        </Badge>
                      </div>
                      <p class="mt-0.5 truncate text-[11px] text-muted-foreground font-normal">
                        歌单同步时多任务并发抓取加速，默认 5 首
                      </p>
                    </div>
                  </div>
                  <div class="flex items-center gap-1.5 shrink-0 text-muted-foreground">
                    <ChevronRight class="h-4 w-4 opacity-60" />
                  </div>
                </Button>

                <Button
                  type="button"
                  variant="ghost"
                  class="w-full h-auto rounded-none flex items-center justify-between p-3.5 sm:p-4 text-left hover:bg-muted/40 active:bg-muted/60"
                  @click="navigateTo('transcode')"
                >
                  <div class="flex items-center gap-3.5 min-w-0 pr-2">
                    <div class="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-violet-500/10 text-violet-500">
                      <Cpu class="h-5 w-5" />
                    </div>
                    <div class="min-w-0">
                      <div class="flex items-center gap-2">
                        <span class="text-sm font-bold text-foreground">强制音频转码</span>
                        <Badge :variant="forceTranscode ? 'warning' : 'success'" class="px-2 py-0.5 text-[10px] font-mono">
                          {{ forceTranscode ? `已开启 (${transcodeQualityLabel})` : '已关闭 (直通免转码)' }}
                        </Badge>
                      </div>
                      <p class="mt-0.5 truncate text-[11px] text-muted-foreground font-normal">
                        {{ forceTranscode ? `仅将高于 ${transcodeQualityLabel} 的音频向下转码，低品质自动跳过` : '关闭即原生直通模式，保留下载音源原始格式与音质' }}
                      </p>
                    </div>
                  </div>
                  <div class="flex items-center gap-1.5 shrink-0 text-muted-foreground">
                    <ChevronRight class="h-4 w-4 opacity-60" />
                  </div>
                </Button>
              </div>
            </div>

            <!-- 分组 2: 扩展与账号 -->
            <div>
              <div class="px-1 mb-1.5 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                云端同步
              </div>
              <div class="rounded-2xl border border-border/80 bg-card overflow-hidden divide-y divide-border/60 shadow-sm">
                <Button
                  type="button"
                  variant="ghost"
                  class="w-full h-auto rounded-none flex items-center justify-between p-3.5 sm:p-4 text-left hover:bg-muted/40 active:bg-muted/60"
                  @click="openAccountsModal"
                >
                  <div class="flex items-center gap-3.5 min-w-0 pr-2">
                    <div class="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-sky-500/10 text-sky-500">
                      <UserRound class="h-5 w-5" />
                    </div>
                    <div class="min-w-0">
                      <div class="flex items-center gap-2">
                        <span class="text-sm font-bold text-foreground">音乐平台账号</span>
                        <Badge variant="outline" class="h-4 px-1.5 text-[9px]">网易云 · QQ</Badge>
                      </div>
                      <p class="mt-0.5 truncate text-[11px] text-muted-foreground font-normal">
                        绑定第三方音乐平台，同步自建歌单与我喜欢
                      </p>
                    </div>
                  </div>
                  <div class="flex items-center gap-1.5 shrink-0 text-muted-foreground">
                    <ChevronRight class="h-4 w-4 opacity-60" />
                  </div>
                </Button>
              </div>
            </div>

            <!-- 分组 3: 系统与信息 -->
            <div>
              <div class="px-1 mb-1.5 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                关于与运行
              </div>
              <div class="rounded-2xl border border-border/80 bg-card overflow-hidden divide-y divide-border/60 shadow-sm">
                <Button
                  type="button"
                  variant="ghost"
                  class="w-full h-auto rounded-none flex items-center justify-between p-3.5 sm:p-4 text-left hover:bg-muted/40 active:bg-muted/60"
                  @click="navigateTo('about')"
                >
                  <div class="flex items-center gap-3.5 min-w-0 pr-2">
                    <div class="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
                      <Server class="h-5 w-5" />
                    </div>
                    <div class="min-w-0">
                      <div class="flex items-center gap-2">
                        <span class="text-sm font-bold text-foreground">关于与系统状态</span>
                        <Badge variant="brand" class="px-2 py-0.5 text-[10px]">
                          v2.0.2
                        </Badge>
                      </div>
                      <p class="mt-0.5 truncate text-[11px] text-muted-foreground font-normal">
                        飞牛 NAS 容器生产部署 · 数据库直连
                      </p>
                    </div>
                  </div>
                  <div class="flex items-center gap-1.5 shrink-0 text-muted-foreground">
                    <ChevronRight class="h-4 w-4 opacity-60" />
                  </div>
                </Button>
              </div>
            </div>
          </div>

          <!-- 2. 二级菜单：保存位置 (Directory Level) -->
          <div v-else-if="currentLevel === 'directory'" key="directory" class="space-y-5">
            <!-- 运行中警示横幅 -->
            <div v-if="isTaskRunning" class="flex items-center gap-2.5 p-3 rounded-2xl bg-warning/10 border border-warning/30 text-warning text-xs">
              <AlertTriangle class="h-4 w-4 shrink-0" />
              <span class="leading-5">当前有任务正在执行或排队中，为防止音频写入损坏，已锁定下载目录切换。</span>
            </div>

            <div>
              <div class="mb-3 flex items-center justify-between gap-3">
                <div>
                  <h3 class="text-sm font-bold text-foreground">选择音乐目录</h3>
                  <p class="mt-0.5 text-[10px] leading-4 text-muted-foreground">新歌曲、歌词和封面会保存在此目录并同步入库。</p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  class="h-8 shrink-0 gap-1.5 px-2.5 text-[11px]"
                  :disabled="isLoadingDirs || isTaskRunning"
                  @click="loadDirectories"
                >
                  <RefreshCw class="h-3 w-3" :class="isLoadingDirs ? 'animate-spin' : ''" />
                  刷新
                </Button>
              </div>

              <!-- 飞牛授权目录单选列表 -->
              <div class="space-y-2">
                <Button
                  v-for="d in authorizedDirs"
                  :key="d.path"
                  type="button"
                  variant="ghost"
                  :disabled="isTaskRunning"
                  class="flex h-auto w-full items-start justify-start gap-3 rounded-2xl border p-3.5 text-left whitespace-normal active:scale-[0.99]"
                  :class="[
                    downloadDir === d.path ? 'border-primary/60 bg-primary/10 shadow-sm hover:bg-primary/15' : 'border-border bg-card hover:bg-muted/45',
                    isTaskRunning ? 'opacity-60 cursor-not-allowed' : ''
                  ]"
                  @click="selectDirectory(d)"
                >
                  <span
                    class="grid h-10 w-10 shrink-0 place-items-center rounded-xl transition-colors"
                    :class="downloadDir === d.path ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'"
                  >
                    <FolderCheck v-if="d.is_fnos_authorized" class="h-4 w-4" />
                    <FolderOpen v-else class="h-4 w-4" />
                  </span>
                  <span class="min-w-0 flex-1 font-normal">
                    <span class="flex flex-wrap items-center gap-1.5">
                      <strong class="text-xs text-foreground font-semibold">{{ d.name }}</strong>
                      <Badge v-if="d.is_fnos_authorized" variant="brand" class="px-1.5 py-0.5 text-[9px]">飞牛曲库</Badge>
                      <Badge v-if="d.writable" variant="success" class="px-1.5 py-0.5 text-[9px]">可写入</Badge>
                      <Badge v-else variant="destructive" class="px-1.5 py-0.5 text-[9px]">不可写</Badge>
                    </span>
                    <span class="mt-1 block break-all font-mono text-[10px] leading-4 text-muted-foreground">{{ d.path }}</span>
                    <span class="mt-0.5 block text-[10px] text-muted-foreground">约 {{ d.file_count }} 个音频文件</span>
                  </span>
                  <span
                    class="mt-2 grid h-5 w-5 shrink-0 place-items-center rounded-full border transition-all"
                    :class="downloadDir === d.path ? 'border-primary bg-primary text-primary-foreground' : 'border-border'"
                  >
                    <Check v-if="downloadDir === d.path" class="h-3 w-3 stroke-[3]" />
                  </span>
                </Button>

                <div v-if="isLoadingDirs" class="flex min-h-20 items-center justify-center gap-2 rounded-2xl border border-dashed border-border text-xs text-muted-foreground">
                  <Loader2 class="h-4 w-4 animate-spin text-primary" />正在读取飞牛授权目录…
                </div>
                <div v-else-if="authorizedDirs.length === 0" class="rounded-2xl border border-dashed border-border px-4 py-5 text-center">
                  <p class="text-xs font-semibold text-foreground">没有发现授权目录</p>
                  <p class="mt-1 text-[10px] leading-4 text-muted-foreground">可以在下方直接手动输入音乐目录。</p>
                </div>
              </div>
            </div>

            <!-- 手动填写目录卡片 -->
            <div class="rounded-2xl border border-border bg-muted/30 p-3.5">
              <div class="mb-2 flex items-center justify-between gap-3">
                <label class="flex items-center gap-2 text-xs font-semibold text-foreground">
                  <FolderPlus class="h-3.5 w-3.5 text-primary" />手动指定目录
                </label>
                <span v-if="isVerifyingDir" class="flex items-center gap-1 text-[10px] text-muted-foreground">
                  <Loader2 class="h-3 w-3 animate-spin" />正在检查
                </span>
              </div>
              <div class="flex flex-col gap-2 sm:flex-row">
                <Input
                  v-model="customDirInput"
                  :disabled="isTaskRunning"
                  placeholder="输入音乐曲库目录绝对路径"
                  class="h-10 min-w-0 flex-1 bg-card font-mono text-[11px]"
                  @keyup.enter="verifyCustomDirectory(customDirInput)"
                />
                <Button
                  type="button"
                  variant="secondary"
                  class="h-10 shrink-0 gap-1.5 text-xs font-medium"
                  :disabled="isVerifyingDir || !customDirInput.trim() || isTaskRunning"
                  @click="verifyCustomDirectory(customDirInput)"
                >
                  <FolderCheck class="h-3.5 w-3.5" />检查并选用
                </Button>
              </div>

              <div
                v-if="dirVerifyResult"
                class="mt-3 flex items-start gap-2 rounded-xl border p-2.5 text-[11px] leading-4"
                :class="dirVerifyResult.ok ? 'border-success/30 bg-success/15 text-success' : 'border-destructive/30 bg-destructive/10 text-destructive'"
              >
                <Check v-if="dirVerifyResult.ok" class="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <AlertTriangle v-else class="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <div>
                  <p class="font-semibold">{{ dirVerifyResult.ok ? '目录可用且支持写入' : '此目录无法使用' }}</p>
                  <p v-if="dirVerifyResult.is_fnos_authorized" class="mt-0.5 opacity-80">这是飞牛官方授权目录，下载后将自动触发曲库扫描。</p>
                  <p v-if="dirVerifyResult.error" class="mt-0.5 opacity-80">{{ dirVerifyResult.error }}</p>
                </div>
              </div>
            </div>

            <!-- 说明折叠 -->
            <details class="group rounded-2xl border border-border bg-card px-3.5 py-3 text-[11px] text-muted-foreground">
              <summary class="cursor-pointer list-none font-semibold text-foreground marker:hidden flex items-center justify-between">
                <span>为什么推荐选用飞牛官方授权目录？</span>
                <ChevronRight class="h-3.5 w-3.5 transition-transform group-open:rotate-90 text-muted-foreground" />
              </summary>
              <p class="mt-2 leading-5">
                保存到飞牛音乐已授权的目录后，新下载的无损歌曲、内嵌与外挂歌词、歌手高清写真封面均可被飞牛音乐自动索引与分类。
              </p>
            </details>
          </div>

          <!-- 3. 二级菜单：下载音源 (Source Level) -->
          <div v-else-if="currentLevel === 'source'" key="source" class="space-y-5">
            <div>
              <div class="mb-3">
                <h3 class="text-sm font-bold text-foreground">选择下载音源线路</h3>
                <p class="mt-0.5 text-[10px] leading-4 text-muted-foreground">点击卡片切换线路；若下载失败建议切换至“智能多源聚合”。</p>
              </div>

              <div class="grid grid-cols-2 gap-2.5">
                <Button
                  v-for="src in availableSources"
                  :key="src.id"
                  type="button"
                  variant="ghost"
                  class="relative h-auto min-h-[112px] flex flex-col items-stretch justify-start rounded-2xl border p-3 text-left whitespace-normal active:scale-[0.98]"
                  :class="currentSource === src.id ? 'border-primary/60 bg-primary/10 shadow-sm hover:bg-primary/15' : 'border-border bg-card hover:bg-muted/45'"
                  @click="currentSource = src.id"
                >
                  <span class="flex items-start justify-between gap-2 w-full">
                    <span
                      class="grid h-8 min-w-8 place-items-center rounded-xl px-2 text-[10px] font-bold tracking-tight"
                      :class="currentSource === src.id ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'"
                    >
                      {{ src.id.toUpperCase() }}
                    </span>
                    <span
                      class="grid h-5 w-5 place-items-center rounded-full border transition-colors"
                      :class="currentSource === src.id ? 'border-primary bg-primary text-primary-foreground' : 'border-border text-transparent'"
                    >
                      <Check class="h-3 w-3 stroke-[3]" />
                    </span>
                  </span>
                  <strong class="mt-3 block truncate text-xs text-foreground font-semibold">{{ src.name }}</strong>
                  <span class="mt-1 line-clamp-2 block text-[10px] leading-4 text-muted-foreground font-normal">{{ src.desc }}</span>
                  <span v-if="src.id === 'kw'" class="absolute bottom-2.5 right-3 text-[9px] font-semibold text-primary">推荐默认</span>
                  <span v-else-if="src.id === 'auto'" class="absolute bottom-2.5 right-3 text-[9px] font-semibold text-primary">自动回退</span>
                </Button>
              </div>
            </div>

            <!-- 自定义音源配置 -->
            <div v-if="currentSource === 'custom'" class="space-y-3 rounded-2xl border border-warning/30 bg-warning/[0.06] p-4">
              <div class="flex items-center gap-2 border-b border-border pb-2 text-xs font-bold text-warning">
                <Sliders class="h-4 w-4" />自定义音源配置
              </div>
              <div class="space-y-1.5">
                <label class="flex items-center gap-1.5 text-[11px] font-medium text-foreground">
                  <Server class="h-3.5 w-3.5 text-muted-foreground" />显示名称
                </label>
                <Input v-model="customConfig.name" placeholder="例如：自建音乐解析" class="h-10 bg-card text-xs" />
              </div>
              <div class="space-y-1.5">
                <label class="flex items-center gap-1.5 text-[11px] font-medium text-foreground">
                  <Link2 class="h-3.5 w-3.5 text-muted-foreground" />API 服务地址
                </label>
                <Input v-model="customConfig.api_url" placeholder="https://example.com/api/music" class="h-10 bg-card font-mono text-[11px]" />
                <p class="text-[10px] leading-4 text-muted-foreground">请求时将自动传入歌曲、歌手与音质参数。</p>
              </div>
              <div class="space-y-1.5">
                <label class="flex items-center gap-1.5 text-[11px] font-medium text-foreground">
                  <Key class="h-3.5 w-3.5 text-muted-foreground" />访问密钥（可选）
                </label>
                <Input v-model="customConfig.api_key" type="password" placeholder="API Key / Token" class="h-10 bg-card font-mono text-[11px]" />
              </div>
              <div class="space-y-1.5">
                <label class="flex items-center gap-1.5 text-[11px] font-medium text-foreground">
                  <Sparkles class="h-3.5 w-3.5 text-muted-foreground" />洛雪源脚本 URL（可选）
                </label>
                <Input v-model="customConfig.script_url" placeholder="https://example.com/source.js" class="h-10 bg-card font-mono text-[11px]" />
              </div>
            </div>

            <!-- 音源说明折叠 -->
            <details class="group rounded-2xl border border-border bg-card px-3.5 py-3 text-[11px] text-muted-foreground">
              <summary class="cursor-pointer list-none font-semibold text-foreground marker:hidden flex items-center justify-between">
                <span>音源解析说明</span>
                <ChevronRight class="h-3.5 w-3.5 transition-transform group-open:rotate-90 text-muted-foreground" />
              </summary>
              <div class="mt-2 space-y-2 leading-5">
                <p>内置音源基于开源生态，全面支持 FLAC 无损与 320K 高品质音频检索。</p>
                <p>建议选用“智能多源”，当主线路遇网络波动或版权限制时，系统会自动平滑降级切换至备选线路。</p>
              </div>
            </details>
          </div>

          <!-- 4. 二级菜单：并发下载设置 (Concurrency Level) -->
          <div v-else-if="currentLevel === 'concurrency'" key="concurrency" class="space-y-4">
            <div class="rounded-2xl border border-border/80 bg-card p-4 space-y-4 shadow-sm">
              <div class="flex items-center gap-3">
                <div class="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-amber-500/10 text-amber-500">
                  <Layers class="h-5 w-5" />
                </div>
                <div>
                  <h4 class="text-sm font-bold text-foreground">同时下载歌曲数 (1 ~ 10)</h4>
                  <p class="text-xs text-muted-foreground">歌单同步时多任务并发抓取加速，默认 5 首</p>
                </div>
              </div>

              <!-- 预设选择胶囊 -->
              <div class="pt-1">
                <SpringTabs
                  v-model="concurrentDownloads"
                  :items="concurrencyPresetTabs"
                  size="sm"
                  full-width
                />
              </div>

              <!-- 自定义输入 -->
              <div class="space-y-1.5 pt-2 border-t border-border/60">
                <label class="text-[11px] font-medium text-foreground">自定义并发数量 (1 ~ 10)</label>
                <div class="flex items-center gap-2">
                  <Input
                    v-model.number="concurrentDownloads"
                    type="number"
                    min="1"
                    max="10"
                    class="h-10 bg-card font-mono text-center font-bold text-sm w-24"
                  />
                  <span class="text-xs text-muted-foreground">首歌曲同时抓取</span>
                </div>
              </div>
            </div>

            <div class="rounded-2xl border border-border/80 bg-card p-4 space-y-2 text-xs text-muted-foreground shadow-sm">
              <div class="flex items-center gap-2 font-semibold text-foreground">
                <Sparkles class="h-4 w-4 text-amber-500" />
                <span>并发下载提示</span>
              </div>
              <p class="text-[11px] leading-5">
                • 默认设为 5 首并发，可在兼顾 NAS 性能与音源 API 稳定性的同时大幅缩短长歌单同步耗时。<br>
                • 若网络带宽有限或音源遇到频繁频控，可适当调低为 1~3 首；若网络通畅可调高为 5~10 首。
              </p>
            </div>
          </div>

          <!-- 5. 二级菜单：强制音频转码 (Transcode Level) -->
          <div v-else-if="currentLevel === 'transcode'" key="transcode" class="space-y-4">
            <div class="rounded-2xl border border-border/80 bg-card p-4 space-y-4 shadow-sm">
              <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div class="flex items-center gap-3">
                  <div class="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-violet-500/10 text-violet-500">
                    <Cpu class="h-5 w-5" />
                  </div>
                  <div>
                    <h4 class="text-sm font-bold text-foreground">强制音频转码</h4>
                    <p class="text-xs text-muted-foreground">直通模式保留原格式；开启转码后仅将高于目标品质的音频向下转码</p>
                  </div>
                </div>
                <SpringTabs
                  v-model="transcodeMode"
                  :items="transcodeModeTabs"
                  size="sm"
                  class="shrink-0"
                />
              </div>

              <!-- 当前状态提示条 -->
              <div
                class="rounded-xl border px-3.5 py-2.5 text-[11px] leading-5 transition-colors"
                :class="forceTranscode
                  ? 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300'
                  : 'border-success/40 bg-success/10 text-emerald-700 dark:text-emerald-300'"
              >
                <span v-if="!forceTranscode" class="font-medium">
                  已关闭强制转码（当前处于直通模式）：所有下载歌曲均保留音源原始格式与品质直接入库，0 CPU 负载。
                </span>
                <span v-else class="font-medium">
                  已开启强制转码（目标品质：{{ transcodeQualityLabel }}）：仅当下载音频品质高于 {{ transcodeQualityLabel }} 时执行向下转码；若低于或等于该品质则自动跳过。
                </span>
              </div>

              <!-- 目标转码品质选择列表 -->
              <div class="space-y-2 pt-1">
                <div class="flex items-center justify-between px-0.5">
                  <span class="text-xs font-bold text-foreground">选择目标转码品质 / 格式</span>
                  <span class="text-[10px] text-muted-foreground">仅支持高品质 → 低品质单向转码</span>
                </div>
                <div class="space-y-2" :class="!forceTranscode ? 'opacity-65' : ''">
                  <Button
                    v-for="opt in transcodeQualityOptions"
                    :key="opt.id"
                    type="button"
                    variant="ghost"
                    class="w-full h-auto rounded-xl border p-3 text-left whitespace-normal flex items-start justify-between gap-3"
                    :class="transcodeQuality === opt.id
                      ? 'border-primary bg-primary/10 shadow-sm hover:bg-primary/15'
                      : 'border-border/70 bg-muted/20 hover:bg-muted/40'"
                    @click="selectTranscodeQuality(opt.id)"
                  >
                    <div class="space-y-1 min-w-0 flex-1 font-normal">
                      <div class="flex items-center gap-2">
                        <span class="text-xs font-bold text-foreground">{{ opt.name }}</span>
                        <Badge variant="outline" class="text-[9px] h-4 px-1.5" :class="transcodeQuality === opt.id ? 'border-primary/50 text-primary' : ''">
                          {{ opt.badge }}
                        </Badge>
                      </div>
                      <p class="text-[11px] leading-4 text-muted-foreground">
                        {{ opt.desc }}
                      </p>
                    </div>
                    <div
                      class="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full border transition-colors"
                      :class="transcodeQuality === opt.id ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/40'"
                    >
                      <Check v-if="transcodeQuality === opt.id" class="h-3 w-3 stroke-[3]" />
                    </div>
                  </Button>
                </div>
              </div>
            </div>

            <div class="rounded-2xl border border-border/80 bg-card p-4 space-y-2 text-xs text-muted-foreground shadow-sm">
              <div class="flex items-center gap-2 font-semibold text-foreground">
                <Sparkles class="h-4 w-4 text-violet-500" />
                <span>转码规则说明</span>
              </div>
              <p class="text-[11px] leading-5">
                • <strong>直通免转码</strong>：直接保存音源原格式与采样率。<br>
                • <strong>仅高转低</strong>：只从高品质向低品质转码（例如下载 FLAC 转 MP3），不执行 MP3 转 FLAC 的反向升频。<br>
                • <strong>智能跳过</strong>：若下载品质低于或等于所选目标，自动跳过该歌曲转码。
              </p>
            </div>
          </div>

          <!-- 4. 二级菜单：关于与系统状态 (About Level) -->
          <div v-else-if="currentLevel === 'about'" key="about" class="space-y-4">
            <div class="rounded-2xl border border-border/80 bg-card p-4 space-y-3 shadow-sm">
              <div class="flex items-center gap-3">
                <div class="grid h-12 w-12 place-items-center rounded-2xl bg-primary/10 text-primary">
                  <Server class="h-6 w-6" />
                </div>
                <div>
                  <h4 class="text-sm font-bold text-foreground">TRIM Music Hub</h4>
                  <p class="text-xs text-muted-foreground">飞牛私有云音乐导入与曲库管理中枢</p>
                </div>
              </div>

              <div class="grid grid-cols-2 gap-2 pt-2 text-[11px]">
                <div class="rounded-xl bg-muted/40 p-2.5">
                  <span class="text-muted-foreground block text-[10px]">系统版本</span>
                  <span class="font-mono font-semibold text-foreground">v2.0.2</span>
                </div>
                <div class="rounded-xl bg-muted/40 p-2.5">
                  <span class="text-muted-foreground block text-[10px]">运行架构</span>
                  <span class="font-semibold text-foreground">Docker 隔离容器</span>
                </div>
                <div class="rounded-xl bg-muted/40 p-2.5 col-span-2">
                  <span class="text-muted-foreground block text-[10px]">飞牛音乐数据库</span>
                  <span class="font-mono text-foreground break-all text-[10.5px]">/usr/local/apps/@appdata/trim.music/db/music.db</span>
                </div>
                <div class="rounded-xl bg-muted/40 p-2.5 col-span-2">
                  <span class="text-muted-foreground block text-[10px]">当前有效下载目录</span>
                  <span class="font-mono text-foreground break-all text-[10.5px]">{{ downloadDir || '未配置' }}</span>
                </div>
              </div>
            </div>

            <div class="rounded-2xl border border-border/80 bg-card p-4 space-y-2.5 text-xs text-muted-foreground shadow-sm">
              <div class="flex items-center gap-2 font-semibold text-foreground">
                <ShieldCheck class="h-4 w-4 text-emerald-500" />
                <span>曲库双轨查重机制</span>
              </div>
              <p class="text-[11px] leading-5">
                所有下载与歌单同步操作均受底层双轨查重保护，既校对飞牛官方 SQLite 数据库，同时检索本地物理音频文件，杜绝冗余重复下载。
              </p>
            </div>
          </div>
        </Transition>
      </div>

      <!-- 底部 Footer -->
      <DialogFooter class="safe-bottom shrink-0 border-t border-border/80 bg-popover/95 px-4 py-3 backdrop-blur sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <!-- 一级菜单底部：显示当前配置概要 + 完成/关闭 -->
        <template v-if="currentLevel === 'root'">
          <div class="hidden min-w-0 max-w-[270px] sm:block">
            <p class="text-[9px] text-muted-foreground">当前有效配置</p>
            <p class="truncate font-mono text-[10px] text-foreground/75">
              {{ selectedSourceName }} · {{ compactDownloadDir || '默认目录' }}
            </p>
          </div>
          <div class="flex w-full sm:w-auto justify-end gap-2">
            <Button
              variant="outline"
              class="h-10 w-full sm:w-auto px-5 text-xs font-semibold"
              @click="handleOpenUpdate(false)"
            >
              完成
            </Button>
          </div>
        </template>

        <!-- 二级操作菜单底部：提供返回上级与保存操作 -->
        <template v-else>
          <div class="flex w-full items-center justify-between gap-2">
            <Button
              variant="outline"
              class="h-10 gap-1 px-3 text-xs font-medium"
              @click="navigateBack"
            >
              <ChevronLeft class="h-4 w-4" />
              <span>返回</span>
            </Button>

            <Button
              v-if="currentLevel !== 'about' && props.currentUser?.isAdmin"
              class="h-10 gap-1.5 px-5 font-semibold text-xs min-w-[100px]"
              :disabled="isSaving"
              @click="handleSave"
            >
              <Loader2 v-if="isSaving" class="h-3.5 w-3.5 animate-spin" />
              <span>{{ isSaving ? '保存中…' : (props.isFirstInstall ? '完成配置' : '保存更改') }}</span>
            </Button>
          </div>
        </template>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

<style scoped>
/* 移动端级平滑推入 / 返回过渡 */
.slide-left-enter-active,
.slide-left-leave-active,
.slide-right-enter-active,
.slide-right-leave-active {
  transition: all 0.22s cubic-bezier(0.16, 1, 0.3, 1);
}

.slide-left-enter-from {
  opacity: 0;
  transform: translateX(20px);
}
.slide-left-leave-to {
  opacity: 0;
  transform: translateX(-20px);
}

.slide-right-enter-from {
  opacity: 0;
  transform: translateX(-20px);
}
.slide-right-leave-to {
  opacity: 0;
  transform: translateX(20px);
}
</style>
