/// <reference types="@cloudflare/workers-types" />

import { Hono, type Context } from 'hono';

type SyncStatus = 'pending' | 'synced' | 'disabled' | 'skipped' | 'error';

type LineRow = {
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
  cf_sync_status: SyncStatus | string;
  cf_sync_message: string;
  cf_last_synced_at: string;
  created_at: string;
  updated_at: string;
};

type FastDomainRow = {
  id: number;
  domain: string;
  label: string;
  is_default: number;
  created_at: string;
};

type Bindings = {
  DB: D1Database;
  ADMIN_PASSWORD?: string;
  CF_API_TOKEN?: string;
  CF_ZONE_ID?: string;
  CF_DNS_PROXIED?: string;
  ASSETS: Fetcher;
};

type CloudflareConfig = {
  apiToken: string;
  zoneIdOverride: string;
  proxied: boolean;
};

type CloudflareApiError = {
  code?: number;
  message?: string;
};

type CloudflareApiResponse<T> = {
  success: boolean;
  errors?: CloudflareApiError[];
  messages?: Array<{ message?: string }>;
  result: T;
  result_info?: {
    page?: number;
    per_page?: number;
    total_pages?: number;
    count?: number;
    total_count?: number;
  };
};

type CloudflareDnsRecord = {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied?: boolean;
};

type CloudflareZone = {
  id: string;
  name: string;
  status?: string;
};

type SyncResult = {
  zoneId: string;
  recordId: string;
  status: SyncStatus;
  message: string;
};

type LineSyncSummary = {
  id: number;
  name: string;
  cf_sync_status: string;
  cf_sync_message: string;
};

const app = new Hono<{ Bindings: Bindings }>();
const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';
const ZONE_CACHE_TTL_MS = 5 * 60 * 1000;
const zoneCache = new Map<string, { expiresAt: number; zones: CloudflareZone[] }>();

const DEFAULT_FAST_DOMAINS: Array<{ domain: string; label: string }> = [
  { domain: 'youxuan.cf.090227.xyz', label: 'CM优选域名' },
  { domain: 'mfa.gov.ua', label: '国家优选' },
  { domain: 'store.ubi.com', label: '育碧优选' },
  { domain: 'saas.sin.fan', label: 'MIYU优选' },
  { domain: 'cf.tencentapp.cn', label: 'ktff维护优选' },
  { domain: 'lily.lat', label: 'Lily姐' },
];

const ensureDefaultFastDomains = async (db: D1Database) => {
  for (const item of DEFAULT_FAST_DOMAINS) {
    await db
      .prepare(
        'INSERT OR IGNORE INTO fast_domains (domain, label, is_default, created_at) VALUES (?, ?, 1, ?)'
      )
      .bind(item.domain, item.label, new Date().toISOString())
      .run();
    await db
      .prepare('UPDATE fast_domains SET label = ?, is_default = 1 WHERE domain = ?')
      .bind(item.label, item.domain)
      .run();
  }
};

const buildErrorMessage = (err: unknown) => {
  if (err instanceof Error) {
    const message = err.message ?? '';
    if (message.includes('no such table')) {
      return '数据库未初始化，请先执行 D1 migrations apply';
    }
    if (message.includes('no such column')) {
      return '数据库结构过旧，请重新执行 D1 migrations apply';
    }
    if (
      message.includes('Cannot read properties of undefined') &&
      message.includes('prepare')
    ) {
      return 'D1 未绑定，请检查 wrangler.toml 的 DB 绑定';
    }
  }
  return '服务器内部错误';
};

const ensureDB = (c: Context<{ Bindings: Bindings }>) => {
  if (!c.env.DB) {
    return c.json({ error: 'D1 未绑定，请检查 wrangler.toml 的 DB 绑定' }, 500);
  }
  return null;
};

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: buildErrorMessage(err) }, 500);
});

const toLine = (row: Record<string, unknown>): LineRow => ({
  id: Number(row.id),
  name: String(row.name ?? ''),
  entry_domain: String(row.entry_domain ?? ''),
  origin_domain: String(row.origin_domain ?? ''),
  fast_domain: String(row.fast_domain ?? ''),
  weight: Number(row.weight ?? 0),
  tags: String(row.tags ?? ''),
  enabled: Number(row.enabled ?? 0),
  notes: String(row.notes ?? ''),
  cf_zone_id: String(row.cf_zone_id ?? ''),
  cf_dns_record_id: String(row.cf_dns_record_id ?? ''),
  cf_sync_status: String(row.cf_sync_status ?? 'pending'),
  cf_sync_message: String(row.cf_sync_message ?? ''),
  cf_last_synced_at: String(row.cf_last_synced_at ?? ''),
  created_at: String(row.created_at ?? ''),
  updated_at: String(row.updated_at ?? ''),
});

const toFastDomain = (row: Record<string, unknown>): FastDomainRow => ({
  id: Number(row.id),
  domain: String(row.domain ?? ''),
  label: String(row.label ?? ''),
  is_default: Number(row.is_default ?? 0),
  created_at: String(row.created_at ?? ''),
});

const getAuthError = (env: Bindings, authHeader?: string | null) => {
  if (!env.ADMIN_PASSWORD) {
    return { status: 500, body: { error: 'ADMIN_PASSWORD not set' } };
  }
  if (!authHeader || authHeader !== `Bearer ${env.ADMIN_PASSWORD}`) {
    return { status: 401, body: { error: 'Unauthorized' } };
  }
  return null;
};

const normalizeDomain = (value: string) =>
  value
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '')
    .toLowerCase();

const isValidDomain = (value: string) => {
  if (!value || value.length > 255) return false;
  if (value.includes(' ')) return false;
  return value.includes('.') && !value.startsWith('.') && !value.endsWith('.');
};

const hostnameBelongsToZone = (hostname: string, zoneName: string) =>
  hostname === zoneName || hostname.endsWith(`.${zoneName}`);

const getCloudflareConfig = (env: Bindings): CloudflareConfig | null => {
  const apiToken = env.CF_API_TOKEN?.trim();
  if (!apiToken) return null;
  return {
    apiToken,
    zoneIdOverride: env.CF_ZONE_ID?.trim() ?? '',
    proxied: env.CF_DNS_PROXIED?.trim().toLowerCase() !== 'false',
  };
};

const formatCloudflareErrors = (errors?: CloudflareApiError[]) => {
  const messages = (errors ?? [])
    .map((item) => item.message?.trim())
    .filter((item): item is string => Boolean(item));
  if (messages.length > 0) {
    return messages.join('; ');
  }
  return 'Cloudflare API 请求失败';
};

const cloudflareRequestEnvelope = async <T>(
  config: CloudflareConfig,
  path: string,
  init?: RequestInit
): Promise<CloudflareApiResponse<T>> => {
  const response = await fetch(`${CLOUDFLARE_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.apiToken}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });

  const payload = (await response.json()) as CloudflareApiResponse<T>;
  if (!response.ok || !payload.success) {
    throw new Error(formatCloudflareErrors(payload.errors));
  }

  return payload;
};

const cloudflareRequest = async <T>(
  config: CloudflareConfig,
  path: string,
  init?: RequestInit
) => {
  const payload = await cloudflareRequestEnvelope<T>(config, path, init);
  return payload.result;
};

const getZoneCacheKey = (config: CloudflareConfig) =>
  `${config.apiToken}:${config.zoneIdOverride}`;

const listAllZones = async (config: CloudflareConfig, forceRefresh = false) => {
  const cacheKey = getZoneCacheKey(config);
  const cached = zoneCache.get(cacheKey);
  const now = Date.now();
  if (!forceRefresh && cached && cached.expiresAt > now) {
    return cached.zones;
  }

  const zones: CloudflareZone[] = [];
  const perPage = 50;
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages) {
    const query = new URLSearchParams({
      page: String(page),
      per_page: String(perPage),
      order: 'name',
      direction: 'asc',
    });
    const payload = await cloudflareRequestEnvelope<CloudflareZone[]>(
      config,
      `/zones?${query.toString()}`,
      {
        method: 'GET',
      }
    );
    zones.push(...payload.result);
    totalPages = payload.result_info?.total_pages ?? page;
    page += 1;
  }

  zoneCache.set(cacheKey, {
    expiresAt: now + ZONE_CACHE_TTL_MS,
    zones,
  });

  return zones;
};

const getZoneDetails = async (config: CloudflareConfig, zoneId: string) => {
  return cloudflareRequest<CloudflareZone>(config, `/zones/${zoneId}`, {
    method: 'GET',
  });
};

const matchZoneFromList = (hostname: string, zones: CloudflareZone[]) => {
  const matches = zones.filter((zone) => hostnameBelongsToZone(hostname, zone.name));
  if (matches.length === 0) return null;

  matches.sort((a, b) => {
    const activeScore = Number(b.status === 'active') - Number(a.status === 'active');
    if (activeScore !== 0) return activeScore;
    return b.name.length - a.name.length;
  });

  return matches[0];
};

const resolveZoneForHostname = async (config: CloudflareConfig, hostname: string) => {
  if (config.zoneIdOverride) {
    const zone = await getZoneDetails(config, config.zoneIdOverride);
    if (!hostnameBelongsToZone(hostname, zone.name)) {
      throw new Error(`访问域名 ${hostname} 不属于当前配置的 Zone ${zone.name}`);
    }
    return zone;
  }

  const zones = await listAllZones(config);
  const matched = matchZoneFromList(hostname, zones);
  if (!matched) {
    throw new Error(`没有找到可管理 ${hostname} 的 Cloudflare Zone`);
  }
  return matched;
};

const listDnsRecordsByName = async (
  config: CloudflareConfig,
  zoneId: string,
  name: string
) => {
  const query = new URLSearchParams({
    name,
    per_page: '100',
  });
  return cloudflareRequest<CloudflareDnsRecord[]>(
    config,
    `/zones/${zoneId}/dns_records?${query.toString()}`,
    {
      method: 'GET',
    }
  );
};

const createDnsRecord = async (
  config: CloudflareConfig,
  zoneId: string,
  name: string,
  content: string
) => {
  return cloudflareRequest<CloudflareDnsRecord>(config, `/zones/${zoneId}/dns_records`, {
    method: 'POST',
    body: JSON.stringify({
      type: 'CNAME',
      name,
      content,
      proxied: config.proxied,
      ttl: 1,
    }),
  });
};

const updateDnsRecord = async (
  config: CloudflareConfig,
  zoneId: string,
  recordId: string,
  name: string,
  content: string
) => {
  return cloudflareRequest<CloudflareDnsRecord>(
    config,
    `/zones/${zoneId}/dns_records/${recordId}`,
    {
      method: 'PUT',
      body: JSON.stringify({
        type: 'CNAME',
        name,
        content,
        proxied: config.proxied,
        ttl: 1,
      }),
    }
  );
};

const deleteDnsRecord = async (
  config: CloudflareConfig,
  zoneId: string,
  recordId: string
) => {
  await cloudflareRequest<{ id: string }>(
    config,
    `/zones/${zoneId}/dns_records/${recordId}`,
    {
      method: 'DELETE',
    }
  );
};

const getLineById = async (db: D1Database, id: number) => {
  const row = await db.prepare('SELECT * FROM lines WHERE id = ?').bind(id).first();
  return row ? toLine(row as Record<string, unknown>) : null;
};

const persistLineSyncState = async (
  db: D1Database,
  lineId: number,
  result: SyncResult
) => {
  const now = new Date().toISOString();
  await db
    .prepare(
      'UPDATE lines SET cf_zone_id = ?, cf_dns_record_id = ?, cf_sync_status = ?, cf_sync_message = ?, cf_last_synced_at = ?, updated_at = ? WHERE id = ?'
    )
    .bind(
      result.zoneId,
      result.recordId,
      result.status,
      result.message,
      now,
      now,
      lineId
    )
    .run();

  const updated = await getLineById(db, lineId);
  if (!updated) {
    throw new Error('Failed to reload line after Cloudflare sync');
  }
  return updated;
};

const resolveManagedZoneId = async (config: CloudflareConfig, line: LineRow) => {
  if (line.cf_zone_id) {
    return line.cf_zone_id;
  }
  const zone = await resolveZoneForHostname(config, line.entry_domain);
  return zone.id;
};

const syncEnabledLineDns = async (
  config: CloudflareConfig,
  zone: CloudflareZone,
  line: LineRow,
  recordId = ''
): Promise<SyncResult> => {
  if (recordId) {
    const updatedRecord = await updateDnsRecord(
      config,
      zone.id,
      recordId,
      line.entry_domain,
      line.fast_domain
    );
    return {
      zoneId: zone.id,
      recordId: updatedRecord.id,
      status: 'synced',
      message: `Cloudflare DNS 已同步: ${line.entry_domain} -> ${line.fast_domain}`,
    };
  }

  const existingRecords = await listDnsRecordsByName(config, zone.id, line.entry_domain);
  const exactNameRecords = existingRecords.filter((record) => record.name === line.entry_domain);
  const cnameRecords = exactNameRecords.filter((record) => record.type === 'CNAME');
  const otherRecords = exactNameRecords.filter((record) => record.type !== 'CNAME');

  if (otherRecords.length > 0) {
    throw new Error(
      `Cloudflare DNS 中已存在 ${line.entry_domain} 的非 CNAME 记录，请手动处理后再重试同步`
    );
  }

  if (cnameRecords.length > 1) {
    throw new Error(
      `Cloudflare DNS 中存在多条 ${line.entry_domain} 的 CNAME 记录，请先手动清理`
    );
  }

  if (cnameRecords.length === 1) {
    const [record] = cnameRecords;
    if (record.content !== line.fast_domain) {
      throw new Error(
        `Cloudflare DNS 中已存在 ${line.entry_domain} -> ${record.content}，为避免覆盖现有配置，本项目不会自动接管`
      );
    }

    const updatedRecord = await updateDnsRecord(
      config,
      zone.id,
      record.id,
      line.entry_domain,
      line.fast_domain
    );
    return {
      zoneId: zone.id,
      recordId: updatedRecord.id,
      status: 'synced',
      message: `Cloudflare DNS 已接管现有记录: ${line.entry_domain} -> ${line.fast_domain}`,
    };
  }

  const createdRecord = await createDnsRecord(
    config,
    zone.id,
    line.entry_domain,
    line.fast_domain
  );
  return {
    zoneId: zone.id,
    recordId: createdRecord.id,
    status: 'synced',
    message: `Cloudflare DNS 已创建: ${line.entry_domain} -> ${line.fast_domain}`,
  };
};

const syncLineWithCloudflare = async (
  env: Bindings,
  line: LineRow,
  previousLine?: LineRow
) => {
  const config = getCloudflareConfig(env);
  if (!config) {
    return persistLineSyncState(env.DB, line.id, {
      zoneId: line.cf_zone_id,
      recordId: line.cf_dns_record_id,
      status: 'skipped',
      message: '未配置 CF_API_TOKEN，已跳过 Cloudflare DNS 同步',
    });
  }

  const before = previousLine ?? line;

  try {
    if (line.enabled !== 1) {
      if (!before.cf_dns_record_id) {
        return persistLineSyncState(env.DB, line.id, {
          zoneId: '',
          recordId: '',
          status: 'disabled',
          message: '线路已停用，当前没有需要删除的受管 Cloudflare DNS 记录',
        });
      }

      const previousZoneId = await resolveManagedZoneId(config, before);
      await deleteDnsRecord(config, previousZoneId, before.cf_dns_record_id);
      return persistLineSyncState(env.DB, line.id, {
        zoneId: '',
        recordId: '',
        status: 'disabled',
        message: `线路已停用，Cloudflare DNS 记录 ${before.entry_domain} 已删除`,
      });
    }

    const targetZone = await resolveZoneForHostname(config, line.entry_domain);
    const previousZoneId = before.cf_dns_record_id
      ? await resolveManagedZoneId(config, before)
      : '';
    const canUpdateInPlace =
      Boolean(before.cf_dns_record_id) &&
      previousZoneId === targetZone.id &&
      before.entry_domain === line.entry_domain;

    if (canUpdateInPlace) {
      try {
        const result = await syncEnabledLineDns(
          config,
          targetZone,
          line,
          before.cf_dns_record_id
        );
        return persistLineSyncState(env.DB, line.id, result);
      } catch {
        const retryResult = await syncEnabledLineDns(config, targetZone, line);
        return persistLineSyncState(env.DB, line.id, retryResult);
      }
    }

    const createdResult = await syncEnabledLineDns(config, targetZone, line);
    if (before.cf_dns_record_id) {
      try {
        await deleteDnsRecord(config, previousZoneId, before.cf_dns_record_id);
      } catch (err) {
        console.error(err);
        return persistLineSyncState(env.DB, line.id, {
          zoneId: createdResult.zoneId,
          recordId: createdResult.recordId,
          status: 'error',
          message:
            err instanceof Error && err.message
              ? `新记录已创建，但旧记录清理失败: ${err.message}`
              : '新记录已创建，但旧记录清理失败',
        });
      }
    }

    return persistLineSyncState(env.DB, line.id, createdResult);
  } catch (err) {
    console.error(err);
    return persistLineSyncState(env.DB, line.id, {
      zoneId: before.cf_zone_id,
      recordId: before.cf_dns_record_id,
      status: 'error',
      message:
        err instanceof Error && err.message
          ? err.message
          : 'Cloudflare DNS 同步失败，请检查配置后重试',
    });
  }
};

const cleanupDeletedLineDns = async (env: Bindings, line: LineRow) => {
  if (!line.cf_dns_record_id) {
    return '未发现需要清理的受管 Cloudflare DNS 记录';
  }

  const config = getCloudflareConfig(env);
  if (!config) {
    throw new Error('该线路存在受管 Cloudflare DNS 记录，但当前未配置 CF_API_TOKEN，无法安全删除');
  }

  const zoneId = await resolveManagedZoneId(config, line);
  await deleteDnsRecord(config, zoneId, line.cf_dns_record_id);
  return `Cloudflare DNS 记录 ${line.entry_domain} 已删除`;
};

const summarizeLines = (lines: LineRow[]) =>
  lines.reduce(
    (acc, line) => {
      acc.total += 1;
      const status = line.cf_sync_status as SyncStatus;
      if (status === 'synced') acc.synced += 1;
      else if (status === 'error') acc.error += 1;
      else if (status === 'disabled') acc.disabled += 1;
      else if (status === 'skipped') acc.skipped += 1;
      else acc.pending += 1;
      return acc;
    },
    {
      total: 0,
      synced: 0,
      error: 0,
      disabled: 0,
      skipped: 0,
      pending: 0,
    }
  );

const buildLineSyncSummary = (line: LineRow): LineSyncSummary => ({
  id: line.id,
  name: line.name,
  cf_sync_status: line.cf_sync_status,
  cf_sync_message: line.cf_sync_message,
});

app.use('/api/*', async (c, next) => {
  if (c.req.path === '/api/auth/check' || c.req.path === '/api/health') {
    return next();
  }
  const authError = getAuthError(c.env, c.req.header('Authorization'));
  if (authError) {
    return c.json(authError.body, { status: authError.status as 401 | 500 });
  }
  return next();
});

app.post('/api/auth/check', (c) => {
  const authError = getAuthError(c.env, c.req.header('Authorization'));
  if (authError) {
    return c.json(authError.body, { status: authError.status as 401 | 500 });
  }
  return c.json({ ok: true });
});

app.get('/api/health', (c) =>
  c.json({
    ok: true,
    cloudflare_dns_sync: Boolean(getCloudflareConfig(c.env)),
  })
);

app.get('/api/cloudflare/status', async (c) => {
  const dbError = ensureDB(c);
  if (dbError) return dbError;

  const lineResult = await c.env.DB.prepare('SELECT * FROM lines ORDER BY updated_at DESC').all();
  const lines = (lineResult.results ?? []).map(toLine);
  const stats = summarizeLines(lines);
  const config = getCloudflareConfig(c.env);

  if (!config) {
    return c.json({
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
      line_stats: stats,
      error: '未配置 CF_API_TOKEN',
    });
  }

  try {
    const selectedZone = config.zoneIdOverride
      ? await getZoneDetails(config, config.zoneIdOverride)
      : null;
    const accessibleZones = config.zoneIdOverride ? [selectedZone] : await listAllZones(config, true);
    const sampleHostnames = [...new Set(lines.map((line) => line.entry_domain).filter(Boolean))].slice(0, 8);
    const hostnameMatches = sampleHostnames.map((hostname) => {
      const matchedZone = selectedZone ?? matchZoneFromList(hostname, accessibleZones);
      return {
        hostname,
        matched: Boolean(matchedZone),
        zone_id: matchedZone?.id ?? '',
        zone_name: matchedZone?.name ?? '',
      };
    });

    return c.json({
      configured: true,
      api_reachable: true,
      token_configured: true,
      zone_override_configured: Boolean(config.zoneIdOverride),
      zone_mode: config.zoneIdOverride ? 'manual' : 'auto',
      proxied: config.proxied,
      accessible_zone_count: accessibleZones.length,
      accessible_zones: accessibleZones.slice(0, 12),
      selected_zone: selectedZone,
      hostname_matches: hostnameMatches,
      line_stats: stats,
      error: '',
    });
  } catch (err) {
    return c.json({
      configured: true,
      api_reachable: false,
      token_configured: true,
      zone_override_configured: Boolean(config.zoneIdOverride),
      zone_mode: config.zoneIdOverride ? 'manual' : 'auto',
      proxied: config.proxied,
      accessible_zone_count: 0,
      accessible_zones: [],
      selected_zone: null,
      hostname_matches: [],
      line_stats: stats,
      error:
        err instanceof Error && err.message
          ? err.message
          : 'Cloudflare 配置检测失败',
    });
  }
});

app.get('/api/cloudflare/zones', async (c) => {
  const config = getCloudflareConfig(c.env);
  if (!config) {
    return c.json({ error: '未配置 CF_API_TOKEN' }, 400);
  }

  try {
    if (config.zoneIdOverride) {
      const zone = await getZoneDetails(config, config.zoneIdOverride);
      return c.json([zone]);
    }

    const zones = await listAllZones(config, true);
    return c.json(zones);
  } catch (err) {
    return c.json(
      {
        error:
          err instanceof Error && err.message
            ? err.message
            : '读取 Cloudflare Zone 列表失败',
      },
      { status: 502 }
    );
  }
});

app.post('/api/cloudflare/test', async (c) => {
  const config = getCloudflareConfig(c.env);
  if (!config) {
    return c.json({ error: '未配置 CF_API_TOKEN' }, 400);
  }

  let payload: Record<string, unknown> = {};
  try {
    payload = await c.req.json();
  } catch {
    // noop
  }

  const hostname = normalizeDomain(String(payload.hostname ?? c.req.query('hostname') ?? ''));
  if (hostname && !isValidDomain(hostname)) {
    return c.json({ error: 'Invalid domain format' }, 400);
  }

  try {
    const zones = config.zoneIdOverride
      ? [await getZoneDetails(config, config.zoneIdOverride)]
      : await listAllZones(config, true);
    const resolvedZone = hostname ? await resolveZoneForHostname(config, hostname) : zones[0] ?? null;

    return c.json({
      ok: true,
      hostname,
      resolved_zone: resolvedZone,
      accessible_zone_count: zones.length,
      accessible_zones: zones.slice(0, 12),
      proxied: config.proxied,
      zone_mode: config.zoneIdOverride ? 'manual' : 'auto',
    });
  } catch (err) {
    return c.json(
      {
        ok: false,
        error:
          err instanceof Error && err.message
            ? err.message
            : 'Cloudflare 配置检测失败',
      },
      { status: 502 }
    );
  }
});

app.post('/api/cloudflare/resync', async (c) => {
  const dbError = ensureDB(c);
  if (dbError) return dbError;

  let payload: Record<string, unknown> = {};
  try {
    payload = await c.req.json();
  } catch {
    // noop
  }

  const ids = Array.isArray(payload.ids)
    ? payload.ids
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value))
    : [];
  const mode = payload.mode === 'all' ? 'all' : 'failed';

  let rows: Array<Record<string, unknown>> = [];
  if (ids.length > 0) {
    const placeholders = ids.map(() => '?').join(', ');
    const result = await c.env.DB.prepare(
      `SELECT * FROM lines WHERE id IN (${placeholders}) ORDER BY enabled DESC, weight DESC, name ASC`
    )
      .bind(...ids)
      .all();
    rows = result.results ?? [];
  } else if (mode === 'all') {
    const result = await c.env.DB.prepare(
      'SELECT * FROM lines ORDER BY enabled DESC, weight DESC, name ASC'
    ).all();
    rows = result.results ?? [];
  } else {
    const result = await c.env.DB.prepare(
      "SELECT * FROM lines WHERE cf_sync_status IN ('error', 'pending', 'skipped') ORDER BY enabled DESC, weight DESC, name ASC"
    ).all();
    rows = result.results ?? [];
  }

  const lines = rows.map(toLine);
  const results: LineSyncSummary[] = [];

  for (const line of lines) {
    const synced = await syncLineWithCloudflare(c.env, line, line);
    results.push(buildLineSyncSummary(synced));
  }

  const summary = results.reduce(
    (acc, item) => {
      if (item.cf_sync_status === 'synced') acc.synced += 1;
      else if (item.cf_sync_status === 'error') acc.error += 1;
      else if (item.cf_sync_status === 'disabled') acc.disabled += 1;
      else if (item.cf_sync_status === 'skipped') acc.skipped += 1;
      else acc.pending += 1;
      return acc;
    },
    {
      total: results.length,
      synced: 0,
      error: 0,
      disabled: 0,
      skipped: 0,
      pending: 0,
    }
  );

  return c.json({
    ...summary,
    items: results,
  });
});

app.get('/api/lines', async (c) => {
  const dbError = ensureDB(c);
  if (dbError) return dbError;
  const onlyEnabled = c.req.query('enabled') === '1';
  const sql = onlyEnabled
    ? 'SELECT * FROM lines WHERE enabled = 1 ORDER BY weight DESC, name ASC'
    : 'SELECT * FROM lines ORDER BY enabled DESC, weight DESC, name ASC';
  const result = await c.env.DB.prepare(sql).all();
  const lines = (result.results ?? []).map(toLine);
  return c.json(lines);
});

app.get('/api/lines/best', async (c) => {
  const dbError = ensureDB(c);
  if (dbError) return dbError;
  const limitParam = c.req.query('limit');
  const limit = limitParam ? Math.max(1, Math.min(20, Number(limitParam))) : 5;
  const result = await c.env.DB.prepare(
    'SELECT * FROM lines WHERE enabled = 1 ORDER BY weight DESC, name ASC LIMIT ?'
  )
    .bind(limit)
    .all();
  const lines = (result.results ?? []).map(toLine);
  return c.json(lines);
});

app.post('/api/lines', async (c) => {
  const dbError = ensureDB(c);
  if (dbError) return dbError;
  let payload: Record<string, unknown> = {};
  try {
    payload = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }

  const name = String(payload.name ?? '').trim();
  const entryDomain = normalizeDomain(String(payload.entry_domain ?? payload.entryDomain ?? ''));
  const originDomain = normalizeDomain(String(payload.origin_domain ?? payload.originDomain ?? ''));
  const fastDomain = normalizeDomain(String(payload.fast_domain ?? payload.fastDomain ?? ''));

  if (!name || !entryDomain || !originDomain || !fastDomain) {
    return c.json({ error: 'name, entry_domain, origin_domain, fast_domain are required' }, 400);
  }
  if (![entryDomain, originDomain, fastDomain].every(isValidDomain)) {
    return c.json({ error: 'Invalid domain format' }, 400);
  }

  const weight = Number.isFinite(Number(payload.weight))
    ? Math.max(0, Math.round(Number(payload.weight)))
    : 100;
  const tags = String(payload.tags ?? '').trim();
  const enabled = payload.enabled === false || payload.enabled === 0 ? 0 : 1;
  const notes = String(payload.notes ?? '').trim();
  const now = new Date().toISOString();

  const result = await c.env.DB.prepare(
    'INSERT INTO lines (name, entry_domain, origin_domain, fast_domain, weight, tags, enabled, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  )
    .bind(name, entryDomain, originDomain, fastDomain, weight, tags, enabled, notes, now, now)
    .run();

  const id = Number(result.meta?.last_row_id ?? 0);
  const created = await getLineById(c.env.DB, id);
  if (!created) {
    return c.json({ error: 'Failed to create line' }, 500);
  }

  const synced = await syncLineWithCloudflare(c.env, created);
  return c.json(synced, 201);
});

app.put('/api/lines/:id', async (c) => {
  const dbError = ensureDB(c);
  if (dbError) return dbError;
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) {
    return c.json({ error: 'Invalid id' }, 400);
  }

  const current = await getLineById(c.env.DB, id);
  if (!current) {
    return c.json({ error: 'Not found' }, 404);
  }

  let payload: Record<string, unknown> = {};
  try {
    payload = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }

  const name = String(payload.name ?? current.name).trim();
  const entryDomain = normalizeDomain(
    String(payload.entry_domain ?? payload.entryDomain ?? current.entry_domain)
  );
  const originDomain = normalizeDomain(
    String(payload.origin_domain ?? payload.originDomain ?? current.origin_domain)
  );
  const fastDomain = normalizeDomain(
    String(payload.fast_domain ?? payload.fastDomain ?? current.fast_domain)
  );

  if (!name || !entryDomain || !originDomain || !fastDomain) {
    return c.json({ error: 'name, entry_domain, origin_domain, fast_domain are required' }, 400);
  }
  if (![entryDomain, originDomain, fastDomain].every(isValidDomain)) {
    return c.json({ error: 'Invalid domain format' }, 400);
  }

  const weight = Number.isFinite(Number(payload.weight))
    ? Math.max(0, Math.round(Number(payload.weight)))
    : current.weight;
  const tags = payload.tags === undefined ? current.tags : String(payload.tags ?? '').trim();
  const enabled =
    payload.enabled === undefined
      ? current.enabled
      : payload.enabled === false || payload.enabled === 0
      ? 0
      : 1;
  const notes = payload.notes === undefined ? current.notes : String(payload.notes ?? '').trim();
  const now = new Date().toISOString();

  await c.env.DB.prepare(
    'UPDATE lines SET name = ?, entry_domain = ?, origin_domain = ?, fast_domain = ?, weight = ?, tags = ?, enabled = ?, notes = ?, updated_at = ? WHERE id = ?'
  )
    .bind(name, entryDomain, originDomain, fastDomain, weight, tags, enabled, notes, now, id)
    .run();

  const updated = await getLineById(c.env.DB, id);
  if (!updated) {
    return c.json({ error: 'Failed to update line' }, 500);
  }

  const synced = await syncLineWithCloudflare(c.env, updated, current);
  return c.json(synced);
});

app.delete('/api/lines/:id', async (c) => {
  const dbError = ensureDB(c);
  if (dbError) return dbError;
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) {
    return c.json({ error: 'Invalid id' }, 400);
  }

  const existing = await getLineById(c.env.DB, id);
  if (!existing) {
    return c.json({ error: 'Not found' }, 404);
  }

  try {
    const syncMessage = await cleanupDeletedLineDns(c.env, existing);
    const result = await c.env.DB.prepare('DELETE FROM lines WHERE id = ?').bind(id).run();
    return c.json({
      ok: (result.meta?.changes ?? 0) > 0,
      sync_message: syncMessage,
    });
  } catch (err) {
    return c.json(
      {
        error:
          err instanceof Error && err.message
            ? err.message
            : '删除线路前清理 Cloudflare DNS 记录失败',
      },
      { status: 502 }
    );
  }
});

app.get('/api/fast-domains', async (c) => {
  const dbError = ensureDB(c);
  if (dbError) return dbError;
  await ensureDefaultFastDomains(c.env.DB);
  const result = await c.env.DB.prepare(
    'SELECT * FROM fast_domains ORDER BY is_default DESC, domain ASC'
  ).all();
  const list = (result.results ?? []).map(toFastDomain);
  return c.json(list);
});

app.post('/api/fast-domains', async (c) => {
  const dbError = ensureDB(c);
  if (dbError) return dbError;
  let payload: Record<string, unknown> = {};
  try {
    payload = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }

  const domain = normalizeDomain(String(payload.domain ?? ''));
  if (!isValidDomain(domain)) {
    return c.json({ error: 'Invalid domain format' }, 400);
  }
  const label = String(payload.label ?? '').trim();
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    'INSERT OR IGNORE INTO fast_domains (domain, label, is_default, created_at) VALUES (?, ?, 0, ?)'
  )
    .bind(domain, label, now)
    .run();

  const created = await c.env.DB.prepare('SELECT * FROM fast_domains WHERE domain = ?')
    .bind(domain)
    .first();
  if (!created) {
    return c.json({ error: 'Failed to add fast domain' }, 500);
  }
  return c.json(toFastDomain(created as Record<string, unknown>), 201);
});

app.delete('/api/fast-domains/:id', async (c) => {
  const dbError = ensureDB(c);
  if (dbError) return dbError;
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) {
    return c.json({ error: 'Invalid id' }, 400);
  }
  const existing = await c.env.DB.prepare('SELECT * FROM fast_domains WHERE id = ?')
    .bind(id)
    .first();
  if (!existing) {
    return c.json({ error: 'Not found' }, 404);
  }
  const row = toFastDomain(existing as Record<string, unknown>);
  if (row.is_default === 1) {
    return c.json({ error: 'Default domain cannot be deleted' }, 400);
  }
  const result = await c.env.DB.prepare('DELETE FROM fast_domains WHERE id = ?').bind(id).run();
  return c.json({ ok: (result.meta?.changes ?? 0) > 0 });
});

app.all('*', async (c) => {
  if (!c.env.ASSETS) {
    return c.text('Assets not configured', 500);
  }
  return c.env.ASSETS.fetch(c.req.raw);
});

export default app;
