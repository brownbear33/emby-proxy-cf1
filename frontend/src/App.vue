<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';

type LineItem = {
  id: number;
  name: string;
  entry_domain: string;
  origin_domain: string;
  fast_domain: string;
  weight: number;
  tags: string;
  enabled: number;
  notes: string;
  cf_zone_id: string;
  cf_dns_record_id: string;
  cf_sync_status: string;
  cf_sync_message: string;
  cf_last_synced_at: string;
  created_at: string;
  updated_at: string;
};

type FastDomainItem = {
  id: number;
  domain: string;
  label: string;
  is_default: number;
};

type CloudflareZoneItem = {
  id: string;
  name: string;
  status?: string;
};

type CloudflareHostnameMatch = {
  hostname: string;
  matched: boolean;
  zone_id: string;
  zone_name: string;
};

type CloudflareStatus = {
  configured: boolean;
  api_reachable: boolean;
  token_configured: boolean;
  zone_override_configured: boolean;
  zone_mode: string;
  proxied: boolean;
  accessible_zone_count: number;
  accessible_zones: CloudflareZoneItem[];
  selected_zone: CloudflareZoneItem | null;
  hostname_matches: CloudflareHostnameMatch[];
  line_stats: {
    total: number;
    synced: number;
    error: number;
    disabled: number;
    skipped: number;
    pending: number;
  };
  error: string;
};

const API_BASE = '/api';
type ToastType = 'error' | 'success' | 'info';

const password = ref(localStorage.getItem('adminPassword') || '');
const authed = ref(false);
const loading = ref(false);
const lines = ref<LineItem[]>([]);
const fastDomains = ref<FastDomainItem[]>([]);
const search = ref('');
const tagFilter = ref('');
const sortBy = ref<'weight' | 'name' | 'updated'>('weight');
const sortDir = ref<'desc' | 'asc'>('desc');
const showEnabledOnly = ref(false);
const selectedIds = ref<Set<number>>(new Set());
const cloudflareBusy = ref(false);
const cfTestHostname = ref('');
const toast = reactive({
  visible: false,
  message: '',
  type: 'info' as ToastType,
});
const createDefaultCloudflareStatus = (): CloudflareStatus => ({
  configured: false,
  api_reachable: false,
  token_configured: false,
  zone_override_configured: false,
  zone_mode: 'disabled',
  proxied: false,
  accessible_zone_count: 0,
  accessible_zones: [],
  selected_zone: null,
  hostname_matches: [],
  line_stats: {
    total: 0,
    synced: 0,
    error: 0,
    disabled: 0,
    skipped: 0,
    pending: 0,
  },
  error: '',
});
const cloudflareStatus = ref<CloudflareStatus>(createDefaultCloudflareStatus());
let toastTimer: number | null = null;

const form = reactive({
  id: null as number | null,
  name: '',
  entry_domain: '',
  origin_domain: '',
  fast_domain: '',
  weight: 100,
  tags: '',
  enabled: true,
  notes: '',
});

const customFastDomain = ref('');
const CUSTOM_FAST_DOMAIN_VALUE = '__custom__';

const authHeaders = () => ({
  Authorization: `Bearer ${password.value.trim()}`,
});

const clearToast = () => {
  if (toastTimer !== null) {
    window.clearTimeout(toastTimer);
    toastTimer = null;
  }
  toast.visible = false;
  toast.message = '';
};

const showToast = (message: string, type: ToastType = 'error', duration = 3200) => {
  clearToast();
  toast.message = message;
  toast.type = type;
  toast.visible = true;
  toastTimer = window.setTimeout(() => {
    toast.visible = false;
    toastTimer = null;
  }, duration);
};

const handleUnexpectedError = (err: unknown, fallback = '请求失败，请稍后重试') => {
  console.error(err);
  showToast(err instanceof Error && err.message ? err.message : fallback, 'error');
};

const showSyncToast = (line: Pick<LineItem, 'cf_sync_status' | 'cf_sync_message'>, fallback: string) => {
  const message = line.cf_sync_message || fallback;
  if (line.cf_sync_status === 'synced') {
    showToast(message, 'success', 2600);
    return;
  }
  if (line.cf_sync_status === 'error') {
    showToast(`线路已保存，但 ${message}`, 'error', 4200);
    return;
  }
  if (line.cf_sync_status === 'disabled') {
    showToast(message, 'info', 3200);
    return;
  }
  if (line.cf_sync_status === 'skipped') {
    showToast(message, 'info', 3600);
    return;
  }
  showToast(fallback, 'success', 2200);
};

const getSyncStatusText = (status: string) => {
  switch (status) {
    case 'synced':
      return 'CF已同步';
    case 'disabled':
      return 'CF已停用';
    case 'skipped':
      return 'CF未配置';
    case 'error':
      return 'CF同步失败';
    default:
      return 'CF待同步';
  }
};

const getSyncStatusClass = (status: string) => {
  switch (status) {
    case 'synced':
      return 'tag--success';
    case 'disabled':
      return 'tag--muted';
    case 'skipped':
      return 'tag--info';
    case 'error':
      return 'tag--danger';
    default:
      return 'tag--muted';
  }
};

const applyCloudflareStatus = (next: Partial<CloudflareStatus>) => {
  cloudflareStatus.value = {
    ...createDefaultCloudflareStatus(),
    ...cloudflareStatus.value,
    ...next,
    accessible_zones: next.accessible_zones ?? cloudflareStatus.value.accessible_zones,
    hostname_matches: next.hostname_matches ?? cloudflareStatus.value.hostname_matches,
    line_stats: next.line_stats ?? cloudflareStatus.value.line_stats,
    selected_zone:
      next.selected_zone === undefined
        ? cloudflareStatus.value.selected_zone
        : next.selected_zone,
  };
};

const getCloudflareModeText = (mode: string) => {
  switch (mode) {
    case 'manual':
      return '手动 Zone';
    case 'auto':
      return '自动识别 Zone';
    default:
      return '未启用';
  }
};

const handleResponseError = async (response: Response) => {
  let message = `请求失败 (${response.status})`;
  try {
    const data = await response.json();
    if (data?.error) {
      message = data.error;
    }
  } catch {
    // noop
  }
  showToast(message, 'error');
};

const resetForm = () => {
  form.id = null;
  form.name = '';
  form.entry_domain = '';
  form.origin_domain = '';
  form.fast_domain = fastDomains.value[0]?.domain ?? '';
  customFastDomain.value = '';
  form.weight = 100;
  form.tags = '';
  form.enabled = true;
  form.notes = '';
};

const login = async () => {
  clearToast();
  const raw = password.value.trim();
  if (!raw) {
    showToast('请输入登录密码', 'error');
    return;
  }
  loading.value = true;
  try {
    const res = await fetch(`${API_BASE}/auth/check`, {
      method: 'POST',
      headers: authHeaders(),
    });
    if (!res.ok) {
      await handleResponseError(res);
      return;
    }
    localStorage.setItem('adminPassword', raw);
    authed.value = true;
    await loadAll();
  } catch (err) {
    handleUnexpectedError(err, '登录失败，请检查网络或 Cloudflare 配置');
  } finally {
    loading.value = false;
  }
};


const loadLines = async () => {
  try {
    const res = await fetch(`${API_BASE}/lines`, {
      headers: authHeaders(),
    });
    if (!res.ok) {
      await handleResponseError(res);
      return;
    }
    lines.value = await res.json();
    if (!cfTestHostname.value) {
      cfTestHostname.value = lines.value[0]?.entry_domain ?? '';
    }
  } catch (err) {
    handleUnexpectedError(err, '加载线路失败');
  }
};

const loadFastDomains = async () => {
  try {
    const res = await fetch(`${API_BASE}/fast-domains`, {
      headers: authHeaders(),
    });
    if (!res.ok) {
      await handleResponseError(res);
      return;
    }
    fastDomains.value = await res.json();
  } catch (err) {
    handleUnexpectedError(err, '加载优选域名失败');
  }
};

const loadCloudflareStatus = async (showErrorToast = false) => {
  try {
    const res = await fetch(`${API_BASE}/cloudflare/status`, {
      headers: authHeaders(),
    });
    if (!res.ok) {
      if (showErrorToast) {
        await handleResponseError(res);
      }
      return;
    }
    const data = (await res.json()) as CloudflareStatus;
    applyCloudflareStatus(data);
    if (!cfTestHostname.value) {
      cfTestHostname.value = lines.value[0]?.entry_domain ?? '';
    }
  } catch (err) {
    if (showErrorToast) {
      handleUnexpectedError(err, '加载 Cloudflare 状态失败');
    }
  }
};

const loadAll = async () => {
  clearToast();
  loading.value = true;
  try {
    await Promise.all([loadLines(), loadFastDomains(), loadCloudflareStatus()]);
    if (!form.fast_domain) {
      resetForm();
    }
  } finally {
    loading.value = false;
  }
};

const refreshCloudflareStatus = async () => {
  cloudflareBusy.value = true;
  try {
    await loadCloudflareStatus(true);
    showToast(
      cloudflareStatus.value.error ? cloudflareStatus.value.error : 'Cloudflare 状态已刷新',
      cloudflareStatus.value.error ? 'info' : 'success',
      2400
    );
  } finally {
    cloudflareBusy.value = false;
  }
};

const testCloudflareConfig = async () => {
  cloudflareBusy.value = true;
  try {
    const res = await fetch(`${API_BASE}/cloudflare/test`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders(),
      },
      body: JSON.stringify({
        hostname: cfTestHostname.value.trim(),
      }),
    });
    if (!res.ok) {
      await handleResponseError(res);
      return;
    }
    const data = (await res.json()) as {
      hostname: string;
      resolved_zone?: CloudflareZoneItem | null;
    };
    await loadCloudflareStatus();
    if (data.resolved_zone) {
      showToast(
        `Cloudflare 检测通过: ${data.hostname || data.resolved_zone.name} -> ${data.resolved_zone.name}`,
        'success',
        2600
      );
    } else {
      showToast('Cloudflare 检测通过', 'success', 2200);
    }
  } catch (err) {
    handleUnexpectedError(err, 'Cloudflare 配置检测失败');
  } finally {
    cloudflareBusy.value = false;
  }
};

const resyncCloudflare = async (mode: 'failed' | 'all' | 'selected') => {
  const ids =
    mode === 'selected'
      ? [...selectedIds.value]
      : undefined;
  if (mode === 'selected' && (!ids || ids.length === 0)) {
    showToast('请先选择需要重同步的线路', 'error');
    return;
  }

  cloudflareBusy.value = true;
  try {
    const res = await fetch(`${API_BASE}/cloudflare/resync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders(),
      },
      body: JSON.stringify({
        mode: mode === 'all' ? 'all' : 'failed',
        ids,
      }),
    });
    if (!res.ok) {
      await handleResponseError(res);
      return;
    }
    const data = (await res.json()) as {
      total: number;
      synced: number;
      error: number;
      pending: number;
      skipped: number;
      disabled: number;
    };
    await Promise.all([loadLines(), loadCloudflareStatus()]);
    if (data.total === 0) {
      showToast('没有需要重同步的线路', 'info', 2200);
      return;
    }
    if (data.error > 0) {
      showToast(
        `Cloudflare 重同步完成，共 ${data.total} 条，失败 ${data.error} 条`,
        'info',
        3600
      );
      return;
    }
    showToast(`Cloudflare 重同步完成，共 ${data.total} 条`, 'success', 2400);
  } catch (err) {
    handleUnexpectedError(err, 'Cloudflare 重同步失败');
  } finally {
    cloudflareBusy.value = false;
  }
};

const saveLine = async () => {
  clearToast();
  if (!form.name.trim()) {
    showToast('线路名称不能为空', 'error');
    return;
  }
  const resolvedFastDomain =
    form.fast_domain === CUSTOM_FAST_DOMAIN_VALUE
      ? customFastDomain.value.trim()
      : form.fast_domain.trim();
  if (!form.entry_domain.trim() || !form.origin_domain.trim() || !resolvedFastDomain) {
    showToast('访问域名、回源域名、优选域名不能为空', 'error');
    return;
  }
  loading.value = true;
  try {
    const payload = {
      name: form.name.trim(),
      entry_domain: form.entry_domain.trim(),
      origin_domain: form.origin_domain.trim(),
      fast_domain: resolvedFastDomain,
      weight: Number(form.weight),
      tags: form.tags.trim(),
      enabled: form.enabled,
      notes: form.notes.trim(),
    };

    const res = await fetch(
      form.id ? `${API_BASE}/lines/${form.id}` : `${API_BASE}/lines`,
      {
        method: form.id ? 'PUT' : 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders(),
        },
        body: JSON.stringify(payload),
      }
    );

    if (!res.ok) {
      await handleResponseError(res);
      return;
    }

    const saved = (await res.json()) as LineItem;
    resetForm();
    await Promise.all([loadLines(), loadCloudflareStatus()]);
    showSyncToast(saved, '线路已保存');
  } catch (err) {
    handleUnexpectedError(err, '保存线路失败');
  } finally {
    loading.value = false;
  }
};

const editLine = (line: LineItem) => {
  form.id = line.id;
  form.name = line.name;
  form.entry_domain = line.entry_domain;
  form.origin_domain = line.origin_domain;
  const exists = fastDomains.value.some((item) => item.domain === line.fast_domain);
  if (exists) {
    form.fast_domain = line.fast_domain;
    customFastDomain.value = '';
  } else {
    form.fast_domain = CUSTOM_FAST_DOMAIN_VALUE;
    customFastDomain.value = line.fast_domain;
  }
  form.weight = line.weight;
  form.tags = line.tags;
  form.enabled = line.enabled === 1;
  form.notes = line.notes;
};

const removeLine = async (line: LineItem) => {
  if (!confirm(`确定删除线路 ${line.name} 吗？`)) {
    return;
  }
  clearToast();
  loading.value = true;
  try {
    const res = await fetch(`${API_BASE}/lines/${line.id}`, {
      method: 'DELETE',
      headers: authHeaders(),
    });
    if (!res.ok) {
      await handleResponseError(res);
      return;
    }
    const result = (await res.json()) as { ok: boolean; sync_message?: string };
    selectedIds.value.delete(line.id);
    await Promise.all([loadLines(), loadCloudflareStatus()]);
    showToast(result.sync_message || '线路已删除', 'success', 2600);
  } catch (err) {
    handleUnexpectedError(err, '删除线路失败');
  } finally {
    loading.value = false;
  }
};

const toggleEnabled = async (line: LineItem) => {
  clearToast();
  loading.value = true;
  try {
    const res = await fetch(`${API_BASE}/lines/${line.id}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders(),
      },
      body: JSON.stringify({
        enabled: line.enabled === 1 ? 0 : 1,
      }),
    });
    if (!res.ok) {
      await handleResponseError(res);
      return;
    }
    const updated = (await res.json()) as LineItem;
    await Promise.all([loadLines(), loadCloudflareStatus()]);
    showSyncToast(updated, updated.enabled === 1 ? '线路已启用' : '线路已停用');
  } catch (err) {
    handleUnexpectedError(err, '切换线路状态失败');
  } finally {
    loading.value = false;
  }
};

const handleFastDomainChange = (value: string) => {
  if (value !== CUSTOM_FAST_DOMAIN_VALUE) {
    customFastDomain.value = '';
  }
};

const filteredLines = computed(() => {
  const keyword = search.value.trim().toLowerCase();
  const tagKeyword = tagFilter.value.trim().toLowerCase();
  const list = lines.value.filter((line) => {
    if (showEnabledOnly.value && line.enabled !== 1) return false;
    if (keyword) {
      const text = `${line.name} ${line.entry_domain} ${line.origin_domain} ${line.fast_domain} ${
        line.tags
      } ${line.notes}`.toLowerCase();
      if (!text.includes(keyword)) return false;
    }
    if (tagKeyword) {
      const tags = line.tags.toLowerCase().split(',').map((t) => t.trim());
      if (!tags.includes(tagKeyword)) return false;
    }
    return true;
  });

  const sorted = [...list].sort((a, b) => {
    if (sortBy.value === 'name') {
      return a.name.localeCompare(b.name);
    }
    if (sortBy.value === 'updated') {
      return a.updated_at.localeCompare(b.updated_at);
    }
    return b.weight - a.weight;
  });

  if (sortDir.value === 'asc') {
    sorted.reverse();
  }
  return sorted;
});

const selectedCount = computed(() => selectedIds.value.size);
const allSelected = computed(
  () => filteredLines.value.length > 0 && selectedIds.value.size === filteredLines.value.length
);

const toggleSelect = (id: number) => {
  if (selectedIds.value.has(id)) {
    selectedIds.value.delete(id);
  } else {
    selectedIds.value.add(id);
  }
};

const toggleSelectAll = () => {
  if (allSelected.value) {
    selectedIds.value.clear();
  } else {
    selectedIds.value = new Set(filteredLines.value.map((line) => line.id));
  }
};

const clearSelection = () => {
  selectedIds.value.clear();
};

const batchUpdate = async (payload: Record<string, unknown>) => {
  clearToast();
  loading.value = true;
  try {
    const responses = await Promise.all(
      [...selectedIds.value].map((id) =>
        fetch(`${API_BASE}/lines/${id}`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            ...authHeaders(),
          },
          body: JSON.stringify(payload),
        })
      )
    );
    const failed = responses.find((response) => !response.ok);
    if (failed) {
      await handleResponseError(failed);
      return;
    }
    await Promise.all([loadLines(), loadCloudflareStatus()]);
    showToast('批量更新完成', 'success', 2200);
  } catch (err) {
    handleUnexpectedError(err, '批量更新失败');
  } finally {
    loading.value = false;
  }
};

const batchDelete = async () => {
  if (selectedIds.value.size === 0) return;
  if (!confirm(`确定删除已选中的 ${selectedIds.value.size} 条线路吗？`)) return;
  clearToast();
  loading.value = true;
  try {
    const responses = await Promise.all(
      [...selectedIds.value].map((id) =>
        fetch(`${API_BASE}/lines/${id}`, {
          method: 'DELETE',
          headers: authHeaders(),
        })
      )
    );
    const failed = responses.find((response) => !response.ok);
    if (failed) {
      await handleResponseError(failed);
      return;
    }
    selectedIds.value.clear();
    await Promise.all([loadLines(), loadCloudflareStatus()]);
    showToast('批量删除完成', 'success', 2200);
  } catch (err) {
    handleUnexpectedError(err, '批量删除失败');
  } finally {
    loading.value = false;
  }
};

const copyText = async (text: string) => {
  try {
    await navigator.clipboard.writeText(text);
    showToast('已复制到剪贴板', 'success', 1800);
  } catch {
    showToast('复制失败，请手动复制', 'error');
  }
};

const batchMerge = () => {
  const selected = filteredLines.value.filter((line) => selectedIds.value.has(line.id));
  if (selected.length === 0) {
    showToast('请先选择线路', 'error');
    return;
  }
  const text = selected
    .map((line) => `${line.entry_domain} -> ${line.fast_domain} -> ${line.origin_domain}`)
    .join('\n');
  copyText(text);
};

onMounted(() => {
  if (password.value.trim()) {
    login();
  }
});

onBeforeUnmount(() => {
  clearToast();
});
</script>

<template>
  <div class="app" :class="{ 'app--login': !authed }">
    <section v-if="!authed" class="login">
      <div class="login-card">
        <p class="eyebrow">CF 优选反代</p>
        <h1>登录管理台</h1>
        <p class="sub">请输入部署时设置的 `ADMIN_PASSWORD`。</p>
        <div class="field">
          <label>管理密码</label>
          <input
            v-model="password"
            type="password"
            placeholder="ADMIN_PASSWORD"
            @keydown.enter.prevent="login"
          />
        </div>
        <button class="primary" @click="login" :disabled="loading">进入</button>
      </div>
    </section>

    <section v-else class="dashboard">
      <header class="header">
        <h1>Emby反代优选线路管理中心</h1>
      </header>

      <div class="controls">
        <div class="search">
          <input v-model="search" placeholder="搜索线路名称 / 域名 / 备注" />
        </div>
        <div class="filters">
          <input v-model="tagFilter" placeholder="按标签过滤 (单个标签)" />
          <select v-model="sortBy">
            <option value="weight">按权重</option>
            <option value="name">按名称</option>
            <option value="updated">按更新时间</option>
          </select>
          <select v-model="sortDir">
            <option value="desc">降序</option>
            <option value="asc">升序</option>
          </select>
          <label class="toggle">
            <input v-model="showEnabledOnly" type="checkbox" />
            仅显示启用
          </label>
        </div>
      </div>

      <section class="card cf-panel">
        <div class="panel-header">
          <div>
            <h2>Cloudflare 自动联动</h2>
            <p class="sub">自动识别 Zone，检测配置状态，并支持批量补偿同步。</p>
          </div>
          <div class="header-actions">
            <button class="ghost" @click="refreshCloudflareStatus" :disabled="cloudflareBusy || loading">
              刷新状态
            </button>
            <button class="ghost" @click="testCloudflareConfig" :disabled="cloudflareBusy || loading">
              检测配置
            </button>
            <button class="ghost" @click="resyncCloudflare('failed')" :disabled="cloudflareBusy || loading">
              重试异常
            </button>
            <button class="ghost" @click="resyncCloudflare('all')" :disabled="cloudflareBusy || loading">
              全量重同步
            </button>
          </div>
        </div>

        <div class="cf-summary">
          <div class="cf-item">
            <span class="label">Token</span>
            <strong>{{ cloudflareStatus.token_configured ? '已配置' : '未配置' }}</strong>
          </div>
          <div class="cf-item">
            <span class="label">Zone 模式</span>
            <strong>{{ getCloudflareModeText(cloudflareStatus.zone_mode) }}</strong>
          </div>
          <div class="cf-item">
            <span class="label">橙云代理</span>
            <strong>{{ cloudflareStatus.proxied ? '开启' : '关闭' }}</strong>
          </div>
          <div class="cf-item">
            <span class="label">Zone 数量</span>
            <strong>{{ cloudflareStatus.accessible_zone_count }}</strong>
          </div>
          <div class="cf-item">
            <span class="label">同步状态</span>
            <strong>{{ cloudflareStatus.api_reachable ? '联通正常' : '待检测 / 异常' }}</strong>
          </div>
        </div>

        <div class="cf-actions">
          <input
            v-model="cfTestHostname"
            placeholder="输入访问域名做 Zone 检测，例如 emby.example.com"
          />
          <button class="primary" @click="testCloudflareConfig" :disabled="cloudflareBusy || loading">
            检测域名归属
          </button>
        </div>

        <div class="cf-stats">
          <span class="tag">总线路 {{ cloudflareStatus.line_stats.total }}</span>
          <span class="tag tag--success">已同步 {{ cloudflareStatus.line_stats.synced }}</span>
          <span class="tag tag--danger">失败 {{ cloudflareStatus.line_stats.error }}</span>
          <span class="tag tag--info">未配置 {{ cloudflareStatus.line_stats.skipped }}</span>
          <span class="tag tag--muted">待同步 {{ cloudflareStatus.line_stats.pending }}</span>
        </div>

        <p v-if="cloudflareStatus.error" class="meta">
          {{ cloudflareStatus.error }}
        </p>

        <div v-if="cloudflareStatus.selected_zone" class="cf-list">
          <span class="label">当前指定 Zone</span>
          <div class="cf-tags">
            <span class="tag">{{ cloudflareStatus.selected_zone.name }}</span>
          </div>
        </div>

        <div v-if="cloudflareStatus.accessible_zones.length" class="cf-list">
          <span class="label">可用 Zone</span>
          <div class="cf-tags">
            <span v-for="zone in cloudflareStatus.accessible_zones" :key="zone.id" class="tag">
              {{ zone.name }}
            </span>
          </div>
        </div>

        <div v-if="cloudflareStatus.hostname_matches.length" class="cf-list">
          <span class="label">访问域名匹配结果</span>
          <div class="cf-matches">
            <div
              v-for="match in cloudflareStatus.hostname_matches"
              :key="match.hostname"
              class="cf-match"
            >
              <strong>{{ match.hostname }}</strong>
              <span class="meta">
                {{ match.matched ? `匹配到 ${match.zone_name}` : '未匹配到可管理 Zone' }}
              </span>
            </div>
          </div>
        </div>
      </section>

      <div class="layout">
        <aside class="side">
          <div class="card panel">
            <div class="panel-header">
              <h2>{{ form.id ? '编辑线路' : '新增线路' }}</h2>
              <button class="ghost" @click="resetForm" :disabled="loading">清空</button>
            </div>
            <div class="field">
              <label>线路名称</label>
              <input v-model="form.name" placeholder="例如 东京优化线" />
            </div>
            <div class="field">
              <label>访问域名</label>
              <input v-model="form.entry_domain" placeholder="emby.example.com" />
            </div>
            <div class="field">
              <label>回源域名</label>
              <input v-model="form.origin_domain" placeholder="origin.example.com" />
            </div>
            <div class="field">
              <label>优选域名</label>
              <select v-model="form.fast_domain" @change="handleFastDomainChange(form.fast_domain)">
                <option
                  v-for="item in fastDomains"
                  :key="item.id"
                  :value="item.domain"
                >
                  {{ item.label ? `${item.label} (${item.domain})` : item.domain }}
                </option>
                <option :value="CUSTOM_FAST_DOMAIN_VALUE">自定义</option>
              </select>
              <input
                v-if="form.fast_domain === CUSTOM_FAST_DOMAIN_VALUE"
                v-model="customFastDomain"
                placeholder="自定义优选域名"
              />
            </div>
            <div class="field-inline">
              <div class="field">
                <label>权重</label>
                <input v-model.number="form.weight" type="number" min="0" />
              </div>
              <label class="toggle">
                <input v-model="form.enabled" type="checkbox" />
                启用
              </label>
            </div>
            <div class="field">
              <label>标签</label>
              <input v-model="form.tags" placeholder="CN,JP,专线" />
            </div>
            <div class="field">
              <label>备注</label>
              <textarea v-model="form.notes" rows="3" placeholder="说明或测速结果"></textarea>
            </div>
            <button class="primary" @click="saveLine" :disabled="loading">
              {{ form.id ? '保存修改' : '新增线路' }}
            </button>
          </div>
        </aside>

        <main class="main">
          <div class="batch-bar">
            <label class="toggle">
              <input type="checkbox" :checked="allSelected" @change="toggleSelectAll" />
              全选
            </label>
            <span class="meta">已选 {{ selectedCount }} 条</span>
            <button class="ghost" @click="batchMerge">批量整合</button>
            <button class="ghost" @click="batchUpdate({ enabled: 1 })">批量启用</button>
            <button class="ghost" @click="batchUpdate({ enabled: 0 })">批量停用</button>
            <button class="ghost" @click="resyncCloudflare('selected')" :disabled="cloudflareBusy || loading">
              重同步选中CF
            </button>
            <button class="danger" @click="batchDelete">批量删除</button>
            <button class="ghost" @click="clearSelection">清空选择</button>
          </div>

          <div v-if="filteredLines.length === 0" class="empty">
            还没有线路数据，先在左侧新增。
          </div>

          <div v-else class="card-grid">
            <article
              v-for="line in filteredLines"
              :key="line.id"
              class="card line-card"
              :class="{ inactive: line.enabled !== 1 }"
            >
              <header class="line-header">
                <div class="line-title">
                  <input
                    type="checkbox"
                    :checked="selectedIds.has(line.id)"
                    @change="() => toggleSelect(line.id)"
                  />
                  <h3>{{ line.name }}</h3>
                </div>
                <button class="pill" @click="toggleEnabled(line)">
                  {{ line.enabled === 1 ? '停用' : '启用' }}
                </button>
              </header>
              <div class="line-body">
                <div>
                  <span class="label">访问域名</span>
                  <p class="mono">{{ line.entry_domain }}</p>
                </div>
                <div>
                  <span class="label">优选域名</span>
                  <p class="mono">{{ line.fast_domain }}</p>
                </div>
                <div>
                  <span class="label">回源域名</span>
                  <p class="mono">{{ line.origin_domain }}</p>
                </div>
              </div>
              <div class="line-meta">
                <span class="tag">权重 {{ line.weight }}</span>
                <span v-if="line.tags" class="tag">{{ line.tags }}</span>
                <span class="tag" :class="getSyncStatusClass(line.cf_sync_status)">
                  {{ getSyncStatusText(line.cf_sync_status) }}
                </span>
                <span v-if="line.cf_sync_message" class="meta">
                  {{ line.cf_sync_message }}
                </span>
                <span v-if="line.notes" class="meta">{{ line.notes }}</span>
              </div>
              <footer class="line-actions">
                <button class="ghost" @click="editLine(line)">编辑</button>
                <button
                  class="ghost"
                  @click="copyText(line.entry_domain)"
                  title="复制访问域名"
                >
                  复制访问域名
                </button>
                <button class="danger" @click="removeLine(line)">删除</button>
              </footer>
            </article>
          </div>
        </main>
      </div>

      <footer class="footer">
        <span>部署到 Cloudflare Workers + D1</span>
      </footer>
    </section>

    <Transition name="toast">
      <div v-if="toast.visible" class="toast" :class="`toast--${toast.type}`">
        {{ toast.message }}
      </div>
    </Transition>
  </div>
</template>
