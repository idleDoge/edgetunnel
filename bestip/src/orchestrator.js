/**
 * orchestrator: 优选编排器。运行时无关，Worker 与本地拨测脚本共用。
 *
 * 数据闭环：
 *   观测(本地拨测/真实请求) -> 合并历史 -> 评分排序 -> 写 KV(top+obs+meta)
 *
 * 隔离维度：kind(entry/proxy) × isp(cmcc/ct/cu/cf)。
 */
import { probeBatch, candidatesFromCIDR } from './prober.js';
import {
	mergeObservations, rankNodes, pickTop, pickTopK,
} from './core.js';
import {
	loadObservations, saveObservations, saveTop, saveMeta, loadTop,
} from './store-kv.js';

export const DEFAULT_OPTIONS = {
	ports: [443, 2053, 2083, 2087, 2096, 8443],
	samplePerCidr: 4,
	maxCandidates: 120,
	concurrency: 30,
	probeTimeoutMs: 3000,
	maxPerNode: 64,
	topLimit: 20,
	minScore: 20,
};

/**
 * 把一批观测结果并入历史，重新评分并写 KV。
 * 本地拨测脚本与 Worker 内拨测共用此入口。
 *
 * @param {object} kv
 * @param {Array<{key, observation}>} incoming
 * @param {object} scope { kind, isp }
 */
export async function ingestResults(kv, incoming, scope = {}, opts = {}) {
	const cfg = { ...DEFAULT_OPTIONS, ...opts };
	const now = Date.now();
	const { kind = 'entry', isp = 'cf' } = scope;
	if (!kv) throw new Error('missing kv');

	const previous = await loadObservations(kv, kind, isp);
	const store = mergeObservations(previous, incoming, {
		maxPerNode: cfg.maxPerNode, now,
	});
	await saveObservations(kv, store, kind, isp);

	const nodes = Object.entries(store).map(([key, observations]) => ({ key, observations }));
	const ranked = rankNodes(nodes, { limit: cfg.topLimit, now });
	await saveTop(kv, ranked, kind, isp);

	const alive = ranked.filter((r) => r.stats.meanRtt !== null).length;
	await saveMeta(kv, {
		kind, isp, ranAt: now, incoming: incoming.length, alive,
		top: ranked[0] ? { key: ranked[0].key, score: ranked[0].score } : null,
	}, kind, isp);

	return { ranked, alive, kind, isp };
}

/**
 * Worker 内主动拨测一轮（注意：从 CF 边缘发起，测不到用户最后一公里，
 * 仅作辅助；主力数据应来自本地拨测脚本与真实请求）。
 */
export async function runOptimization(deps, opts = {}) {
	const cfg = { ...DEFAULT_OPTIONS, ...opts };
	const now = Date.now();
	const { connect, kv, cidrs, kind = 'entry', isp = 'cf' } = deps;
	if (!connect) throw new Error('missing connect');
	if (!kv) throw new Error('missing kv');
	if (!Array.isArray(cidrs) || cidrs.length === 0) throw new Error('missing cidrs');

	const candidates = candidatesFromCIDR(cidrs, cfg.ports, {
		samplePerCidr: cfg.samplePerCidr,
		maxCandidates: cfg.maxCandidates,
	});
	const incoming = await probeBatch(candidates, connect, {
		concurrency: cfg.concurrency,
		timeoutMs: cfg.probeTimeoutMs,
		at: now,
	});
	const r = await ingestResults(kv, incoming, { kind, isp }, cfg);
	return { ...r, candidates: candidates.length };
}

/** 单节点最佳（兼容旧入口）。 */
export async function selectBest(kv, scope = {}, { minScore = 20 } = {}) {
	const { kind = 'entry', isp = 'cf' } = scope;
	const ranked = await loadTop(kv, kind, isp);
	if (!ranked) return null;
	return pickTop(ranked, { minScore }) ?? null;
}

/**
 * 实测存活的前 K 个节点（订阅前置多个）。
 * scope: { kind, isp }
 */
export async function selectTopK(kv, scope = {}, { k = 10, minScore = 15 } = {}) {
	const ranked = await loadTop(kv, scope.kind ?? 'entry', scope.isp ?? 'cf');
	if (!ranked) return [];
	return pickTopK(ranked, { k, minScore });
}

/**
 * 被动上报真实请求结果（按运营商分桶，零额外拨测成本）。
 * result: { key, ok, rttMs, colo? }
 * scope: { kind, isp }
 */
export async function reportOutcome(kv, result, scope = {}, opts = {}) {
	const now = Date.now();
	const { kind = 'entry', isp = 'cf' } = scope;
	const incoming = [{
		key: result.key,
		observation: {
			rttMs: result.rttMs ?? null, ok: !!result.ok,
			colo: result.colo ?? null, at: now,
		},
	}];
	return ingestResults(kv, incoming, { kind, isp }, opts);
}
