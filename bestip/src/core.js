/**
 * bestip-core: 优选 IP 评分模型（纯逻辑，无运行时依赖，可独立单测）
 *
 * 目标：低延迟 + 稳定优先。综合主动拨测与真实请求的历史观测，
 * 对节点做指数衰减加权评分，输出排序后的 top-N。
 */

/** 评分配置（低延迟+稳定优先） */
export const DEFAULT_WEIGHTS = {
	rtt: 1.0,        // 延迟权重（越低越好）
	failure: 2.5,    // 失败惩罚权重（稳定性最重要）
	jitter: 0.5,     // 抖动权重（RTT 方差）
	colo: 0.3,       // colo 就近加分
	fresh: 0.2,      // 新鲜度
};

/** RTT 归一化参考（ms）：超过此值延迟分趋近最低 */
export const RTT_SCALE_MS = 500;
/** 历史测量半衰期（ms）：默认 6 小时，旧观测指数衰减 */
export const HALF_LIFE_MS = 6 * 60 * 60 * 1000;
/** 优先 colo（亚洲就近），命中给加分 */
export const PREFERRED_COLO = new Set([
	'HKG', 'NRT', 'KIX', 'ICN', 'TPE', 'SIN', 'TSA', 'FMN',
]);

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

/** 指数衰减系数：age 越大权重越低 */
export function decayFactor(ageMs, halfLifeMs = HALF_LIFE_MS) {
	if (ageMs <= 0) return 1;
	return Math.pow(0.5, ageMs / halfLifeMs);
}

/**
 * 把单个节点的历史观测聚合成统计量。
 * observations: [{ rttMs, ok, colo?, at }]，at 为 epoch ms。
 */
export function summarize(observations, now = Date.now()) {
	let wSum = 0, wRtt = 0, wRtt2 = 0, wFail = 0;
	let colo = null, coloW = 0, newest = -Infinity;

	for (const o of observations) {
		const age = now - (o.at ?? now);
		const w = decayFactor(age);
		wSum += w;
		if (o.ok && typeof o.rttMs === 'number' && o.rttMs >= 0) {
			wRtt += w * o.rttMs;
			wRtt2 += w * o.rttMs * o.rttMs;
		} else {
			wFail += w;
		}
		if (o.colo) {
			coloW += w;
			if (w > coloW - w || !colo) colo = o.colo;
		}
		newest = Math.max(newest, o.at ?? now);
	}

	if (wSum === 0) {
		return { samples: 0, meanRtt: null, jitter: null, failRate: 1, colo: null, newest };
	}

	const okW = wSum - wFail;
	// RTT 仅由成功观测决定，按其衰减权重平均；失败观测只影响 failRate。
	const meanRtt = okW > 0 ? wRtt / okW : null;
	const variance = okW > 0 ? Math.max(0, wRtt2 / okW - (meanRtt ?? 0) ** 2) : null;
	const jitter = variance !== null ? Math.sqrt(variance) : null;

	return {
		samples: observations.length,
		weight: wSum,
		meanRtt,
		jitter,
		failRate: wFail / wSum,
		colo,
		newest,
	};
}

/**
 * 计算单个节点综合分（0~100，越高越好）。
 * 低延迟 + 稳定优先：失败惩罚最重。
 */
export function scoreNode(stats, weights = DEFAULT_WEIGHTS, now = Date.now()) {
	if (!stats || stats.samples === 0 || stats.weight === 0) return 0;

	// 延迟分：0ms→1，RTT_SCALE_MS 及以上→~0.14
	const rttScore = stats.meanRtt === null
		? 0
		: clamp(1 - stats.meanRtt / RTT_SCALE_MS, 0, 1);

	// 稳定分：失败率 0→1，失败率 1→0
	const stableScore = 1 - clamp(stats.failRate, 0, 1);

	// 抖动分：jitter 越小越高（150ms 为参考）
	const jitterScore = stats.jitter === null
		? 0.5
		: clamp(1 - stats.jitter / 150, 0, 1);

	// colo 就近加分
	const coloScore = stats.colo && PREFERRED_COLO.has(stats.colo) ? 1 : 0;

	const w = weights;
	const total =
		w.rtt * rttScore +
		w.failure * stableScore +
		w.jitter * jitterScore +
		w.colo * coloScore;
	const denom = w.rtt + w.failure + w.jitter + w.colo;

	// 置信度：样本太少或全失败时压低分数，避免 1 次侥幸拿高分
	const confidence = clamp(stats.weight / 2, 0, 1) * (stats.meanRtt === null ? 0.35 : 1);

	return Math.round((total / denom) * confidence * 1000) / 10;
}

/**
 * 对整批节点评分排序，返回 top-N。
 * nodes: { key, observations[] }[]
 * 返回 { key, score, stats }[]，按分降序。
 */
export function rankNodes(nodes, { limit = 20, weights = DEFAULT_WEIGHTS, now = Date.now() } = {}) {
	const ranked = nodes.map((n) => {
		const stats = summarize(n.observations, now);
		return { key: n.key, score: scoreNode(stats, weights, now), stats };
	});
	ranked.sort((a, b) => b.score - a.score);
	return ranked.slice(0, limit);
}

/**
 * 增量合并：把新一批观测并入已有观测表，做有界裁剪。
 * store: { key: observations[] }
 * incoming: { key, observation }[]
 */
export function mergeObservations(store, incoming, { maxPerNode = 64, now = Date.now() } = {}) {
	const next = { ...store };
	for (const { key, observation } of incoming) {
		const arr = next[key] ? [...next[key], observation] : [observation];
		// 有界：超限时丢弃最旧（已衰减、信息量最低）
		if (arr.length > maxPerNode) arr.splice(0, arr.length - maxPerNode);
		next[key] = arr;
	}
	return next;
}

/**
 * 从评分表中选出 top 节点键，供选择器使用。
 * 返回 null 表示无可用（调用方应回退实时竞速）。
 */
export function pickTop(ranked, { minScore = 20, requireRtt = true } = {}) {
	for (const r of ranked) {
		if (r.score < minScore) continue;
		if (requireRtt && r.stats.meanRtt === null) continue;
		return r;
	}
	return null;
}

/**
 * 选出实测存活的前 K 个节点（订阅前置多个，而非单个）。
 * 仅返回 meanRtt 非空（确认可用）且分数达标的节点。
 * 返回 [{ key, score, rttMs }]。
 */
export function pickTopK(ranked, { k = 10, minScore = 15 } = {}) {
	const out = [];
	for (const r of ranked) {
		if (r.score < minScore) continue;
		if (r.stats.meanRtt === null) continue;
		out.push({ key: r.key, score: r.score, rttMs: Math.round(r.stats.meanRtt) });
		if (out.length >= k) break;
	}
	return out;
}
