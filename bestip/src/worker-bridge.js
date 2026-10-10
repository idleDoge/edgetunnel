/**
 * worker-bridge: 优选功能与 edgetunnel Worker 运行时的适配层。
 *
 * 把运行时的 request.fetcher.connect、env.KV 桥接到优选编排器，
 * 并负责获取 CIDR 列表。供 scheduled（定时）与手动触发共用。
 */
import {
	runOptimization, selectBest, reportOutcome, selectTopK,
} from './orchestrator.js';

/** 兜底 CF 网段（远程 CIDR 拉取失败时使用） */
const FALLBACK_CIDR = ['104.16.0.0/13'];

/**
 * 获取 CIDR 列表。沿用上游按运营商分文件的约定，
 * isp: ct/cu/cmcc/cf。
 */
export async function fetchCIDRs(env, isp = 'cf') {
	const owner = env._BESTIP_CIDR_OWNER || 'cmliu';
	const repo = env._BESTIP_CIDR_REPO || 'cmliu';
	const url = isp === 'cf'
		? `https://raw.githubusercontent.com/${owner}/${repo}/main/CF-CIDR.txt`
		: `https://raw.githubusercontent.com/${owner}/${repo}/main/CF-CIDR/${isp}.txt`;
	try {
		const res = await fetch(url);
		if (!res.ok) return FALLBACK_CIDR;
		const text = await res.text();
		const list = text.split(/[\r\n,]+/).map((s) => s.trim()).filter((s) => /\/\d+$/.test(s));
		return list.length ? list : FALLBACK_CIDR;
	} catch {
		return FALLBACK_CIDR;
	}
}

/** 从 request 构造 connect 注入 */
export function connectFromRequest(request) {
	const fetcher = /** @type {any} */ (request)?.fetcher;
	if (!fetcher || typeof fetcher.connect !== 'function') {
		throw new Error('request.fetcher.connect unavailable');
	}
	return (opts) => fetcher.connect(opts);
}

/**
 * 从 Workers 全局 cloudflare:sockets 构造 connect（供 scheduled 使用）。
 * socket API 与 request.fetcher.connect 一致（带 opened）。
 * 若环境无该模块（如本地单测），回退到传入的 requestFetcher。
 */
export async function connectForScheduled(request) {
	if (request) return connectFromRequest(request);
	try {
		const mod = await import('cloudflare:sockets');
		if (mod && typeof mod.connect === 'function') {
			return (opts) => mod.connect({ hostname: opts.hostname, port: opts.port });
		}
	} catch {
		// fallthrough
	}
	throw new Error('no connect available for scheduled (need cloudflare:sockets or request)');
}

/**
 * scheduled 定时优化：分别优化入口节点与反代出口。
 * @param {object} p
 *   request: 可选，用于拿 fetcher；不传则用全局 cloudflare:sockets
 *   env, isp
 */
export async function scheduledRun({ request, env, isp = 'cf', kinds = ['entry', 'proxy'], options = {} }) {
	const connect = await connectForScheduled(request);
	const kv = env.KV;
	if (!kv) throw new Error('env.KV binding missing');
	const cidrs = await fetchCIDRs(env, isp);

	const summary = {};
	for (const kind of kinds) {
		// eslint-disable-next-line no-await-in-loop
		const r = await runOptimization({ connect, kv, cidrs, kind }, options);
		summary[kind] = { candidates: r.candidates, alive: r.alive, top: r.ranked[0]?.key ?? null };
	}
	return summary;
}

export { selectBest, reportOutcome };

/**
 * 跨运营商回退的 top-K 选择：
 * 先取访问者 isp 桶；若为空（如服务器侧/经转发时识别成 cf），
 * 按 fallbackISPs 顺序回退到其它有实测数据的桶。
 *
 * 这样国内真实用户精确命中自己运营商，其它情况下仍有实测节点可用。
 *
 * @returns {Promise<{items: Array, isp: string}>}
 */
export async function selectTopKFallback(kv, {
	kind = 'entry', isp = 'cf', k = 10, minScore = 15,
	fallbackISPs = ['cmcc', 'ct', 'cu', 'cf'],
} = {}) {
	const order = [isp, ...fallbackISPs.filter((x) => x !== isp)];
	const seen = new Set();
	for (const candidateISP of order) {
		if (seen.has(candidateISP)) continue;
		seen.add(candidateISP);
		// eslint-disable-next-line no-await-in-loop
		const items = await selectTopK(kv, { kind, isp: candidateISP }, { k, minScore });
		if (items.length) return { items, isp: candidateISP };
	}
	return { items: [], isp };
}
