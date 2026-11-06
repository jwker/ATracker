// 接口分发。输入是一次调用（方法 + 路径 + 参数 + 请求体），输出是状态码和载荷。
//
// 这里不关心调用方是谁：主进程的 IPC 直接把调用转进来，测试也可以直接调。
// 所以没有请求对象、没有响应头、没有静态文件——这些都已经不属于应用本身。

import { existsSync } from 'node:fs';

import { COLLECTORS } from '../../collectors/src/scanner.ts';
import { deviceFilePath } from '../../core/src/device.ts';
import { buildInfo } from '../../core/src/build.ts';
import type { ApiCall, ApiResult } from '../../core/src/api.ts';
import { ATrackerService, searchParamsOf } from './service.ts';
import {
  aggregatePayload, calendarPayload, conversationsPayload, conversationPayload,
  dayPayload, logPayload, matrixPayload, totalPayload
} from './queries.ts';

/** 拿请求体里某个字符串字段，类型不对就当没给。 */
function str(body: unknown, key: string): string {
  if (body === null || typeof body !== 'object') return '';
  const v = (body as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : '';
}

/**
 * 处理一次接口调用。返回的 status 沿用原来的 HTTP 语义（400 参数不对、
 * 404 没有这个接口、500 内部错误），界面层照旧按它判断成功与否。
 */
export async function handleApi(service: ATrackerService, call: ApiCall): Promise<ApiResult> {
  const p = call.path;
  const q = searchParamsOf(call.params);
  const ok = (body: unknown): ApiResult => ({ status: 200, body });
  const fail = (error: string, status = 400): ApiResult => ({ status, body: { error } });

  try {
    if (p === '/api/status') {
      const total = totalPayload(service.repo);
      return ok({
        ok: true,
        build: buildInfo(),
        total,
        hasData: total.total > 0,
        scanning: service.isScanning,
        watched: service.watchCount,
        pollMs: service.pollInterval
      });
    }
    if (p === '/api/total') return ok(totalPayload(service.repo, service.deviceFilter(q)));
    if (p === '/api/calendar') {
      return ok(calendarPayload(service.repo, q.get('month') ?? new Date().toISOString().slice(0, 7), service.deviceFilter(q)));
    }
    if (p === '/api/aggregate') {
      return ok(aggregatePayload(service.repo, q.get('from'), q.get('to'), q.get('all') === '1', service.deviceFilter(q)));
    }
    if (p === '/api/matrix') {
      return ok(matrixPayload(service.repo, q.get('from'), q.get('to'), q.get('all') === '1', service.deviceFilter(q)));
    }
    if (p === '/api/day') {
      return ok(dayPayload(service.repo, q.get('date'), service.deviceFilter(q), service.device.id));
    }
    if (p === '/api/conversations') {
      return ok(conversationsPayload(service.repo, {
        dir: q.get('dir'), agent: q.get('agent'), model: q.get('model'),
        vendor: q.get('vendor'), q: q.get('q')
      }));
    }
    if (p === '/api/conversation') {
      const id = q.get('id') ?? '';
      if (!id) return fail('缺少 id');
      // 带 device 的话只查那台设备的会话。列表页把本机和远端的会话混在一起，
      // 不带设备参数会拿到另一台设备上同名 session_id 的数据。
      return ok(conversationPayload(service.repo, id, 200, q.get('device')));
    }
    if (p === '/api/logs') {
      const batch = q.get('batch');
      return ok(logPayload(service.repo, {
        batch: batch ? Number(batch) : null,
        level: q.get('level'), source: q.get('source'), q: q.get('q')
      }));
    }
    if (p === '/api/scan/batches') return ok({ batches: service.repo.recentBatches(50) });
    if (p === '/api/sync') {
      return ok({
        dir: service.syncDir,
        enabled: service.syncDir !== null,
        pollMs: service.syncPollInterval,
        lastExportAt: service.lastExportAt,
        lastExportFiles: service.lastExportFiles,
        lastImportAt: service.lastImportAt,
        lastImport: service.lastImport,
        // 每台设备在本机库里占多少 token：排查「数字翻倍」时一眼能看出是哪台
        devices: service.repo.devices().map((d: any) => ({
          ...d,
          local: d.id === service.device.id,
          tokens: (service.repo.db.prepare(
            'SELECT COALESCE(SUM(tokens),0) t FROM agg_day_agent WHERE device = ?'
          ).get(d.id) as any).t
        }))
      });
    }
    if (p === '/api/devices') {
      return ok({
        local: service.device,
        file: deviceFilePath(),
        devices: service.repo.devices()
      });
    }
    if (p === '/api/doctor') {
      return ok({
        sources: COLLECTORS.map(c => {
          const roots = c.roots();
          const ok2 = roots.some(r => existsSync(r));
          return { id: c.id, label: c.label, roots, ok: ok2 };
        })
      });
    }
    if (p === '/api/sync/ignore' && call.method === 'POST') {
      const id = str(call.body, 'id');
      if (!id) return fail('缺少 id');
      if (id === service.device.id) return fail('不能忽略本机');
      service.repo.ignoreDevice(id);
      return ok({ ok: true, ignored: true });
    }
    if (p === '/api/sync/restore' && call.method === 'POST') {
      const id = str(call.body, 'id');
      if (!id) return fail('缺少 id');
      service.repo.restoreDevice(id);
      // 立刻尝试导一次，用户不用等下一轮轮询
      service.importSync();
      return ok({ ok: true, ignored: false });
    }
    if (p === '/api/device/name' && call.method === 'POST') {
      const name = str(call.body, 'name').trim();
      if (!name) return fail('名字不能为空');
      return ok({ ok: true, device: service.renameDevice(name) });
    }
    if (p === '/api/scan' && call.method === 'POST') {
      void service.triggerScan('manual');
      return ok({ ok: true, queued: true });
    }

    return { status: 404, body: { error: '没有这个接口', path: p } };
  } catch (err) {
    return { status: 500, body: { error: (err as Error).message } };
  }
}
