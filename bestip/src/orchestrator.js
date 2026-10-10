/**
 * orchestrator: 优选编排器。把完整闭环串起来：
 *
 *   CIDR/候选 -> 拨测 -> 合并历史 -> 评分排序 -> 写 KV(top+obs+meta)
 *
 * 依赖全部注入（connect、kv、cidrFetcher），不绑定 Worker 运行时，
 * 由 scheduled / fetch / 面板共用。
 */
import { probeBatch, candidatesFromCIDR } from './prober.js';
import { mergeObservations, rankNodes, pickTop } from './core.js';
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
 * 执行一轮优选。
 * @param {object} deps
 *   connect: fetcher.connect
 *   kv: env.KV
 *   cidrs: string[]（调用方负责获取 CIDR 列表）
 *   kind: 'entry' | 'proxy'  （入口节点 / 反代出口，分别存独立命名空间前缀）
 */
export async function runOptimization(deps, opts = {}) {
	const cfg = { ...DEFAULT_OPTIONS, ...opts };
	const now = Date.now();
	const { connect, kv, cidrs, kind = 'entry' } = deps;
	if (!connect) throw new Error('missing connect');
	if (!kv) throw new Error('missing kv');
	if (!Array.isArray(cidrs) || cidrs.length === 0) throw new Error('missing cidrs');

	// 1) 从 CIDR 生成候选
	const candidates = candidatesFromCIDR(cidrs, cfg.ports, {
		samplePerCidr: cfg.samplePerCidr,
		maxCandidates: cfg.maxCandidates,
	});

	// 2) 批量拨测
	const incoming = await probeBatch(candidates, connect, {
		concurrency: cfg.concurrency,
		timeoutMs: cfg.probeTimeoutMs,
		at: now,
	});

	// 3) 合并历史（kind 隔离存储）
	const previous = await loadObservations(kv, kind);
	const store = mergeObservations(previous, incoming, {
		maxPerNode: cfg.maxPerNode,
		now,
	});
	await saveObservations(kv, store, kind);

	// 4) 评分排序
	const nodes = Object.entries(store).map(([key, observations]) => ({ key, observations }));
	const ranked = rankNodes(nodes, { limit: cfg.topLimit, now });
	await saveTop(kv, ranked, kind);

	// 5) 元数据
	const alive = ranked.filter((r) => r.stats.meanRtt !== null).length;
	await saveMeta(kv, {
		kind, ranAt: now, candidates: candidates.length,
		alive, top: ranked[0] ? { key: ranked[0].key, score: ranked[0].score } : null,
	}, kind);

	return { ranked, store, candidates: candidates.length, alive, kind };
}

/**
 * 请求时选择：优先读 top 快照，返回最佳节点或 null（回退实时竞速）。
 */
export async function selectBest(kv, { kind = 'entry', minScore = 20 } = {}) {
	const ranked = await loadTop(kv, kind);
	if (!ranked) return null;
	const top = pickTop(ranked, { minScore });
	return top ?? null;
}

/**
 * 被动上报：把真实请求的成败并入评分（零额外拨测成本）。
 * result: { key, ok, rttMs, colo? }
 */
export async function reportOutcome(kv, result, { kind = 'entry', maxPerNode = 64 } = {}) {
	const now = Date.now();
	const previous = await loadObservations(kv, kind);
	const incoming = [{
		key: result.key,
		observation: { rttMs: result.rttMs ?? null, ok: !!result.ok, colo: result.colo ?? null, at: now },
	}];
	const store = mergeObservations(previous, incoming, { maxPerNode, now });
	await saveObservations(kv, store, kind);
}
