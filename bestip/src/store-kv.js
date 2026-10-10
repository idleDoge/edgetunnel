/**
 * store: KV 持久化层。把观测表与 top 快照存到 CF KV。
 *
 * kv 由运行时注入（env.KV），形如 CF KV namespace：
 *   get(key) => string|null, put(key, value)
 *
 * 两个隔离维度：
 *   kind: 'entry' | 'proxy'   入口节点 / 反代出口
 *   isp:  'cmcc' | 'ct' | 'cu' | 'cf'  来源运营商（默认 cf）
 *
 * 纯 JSON 序列化在本模块，便于注入内存 mock 与本地脚本共用。
 */

/**
 * 构造 KV 键。形如：
 *   bestip.observations.json                       (entry/cf)
 *   bestip.cmcc.top.json                           (entry/cmcc)
 *   bestip.proxy.cmcc.observations.json            (proxy/cmcc)
 */
function scoped(suffix, kind, isp) {
	const parts = ['bestip'];
	if (kind && kind !== 'entry') parts.push(kind);
	if (isp && isp !== 'cf') parts.push(isp);
	parts.push(suffix);
	return parts.join('.');
}

/** 读取观测表 { key: observations[] } */
export async function loadObservations(kv, kind = 'entry', isp = 'cf') {
	try {
		const raw = await kv.get(scoped('observations.json', kind, isp));
		return raw ? JSON.parse(raw) : {};
	} catch {
		return {};
	}
}

/** 写观测表 */
export async function saveObservations(kv, store, kind = 'entry', isp = 'cf') {
	await kv.put(scoped('observations.json', kind, isp), JSON.stringify(store));
}

/** 读取 top 快照（ranked 结果） */
export async function loadTop(kv, kind = 'entry', isp = 'cf') {
	try {
		const raw = await kv.get(scoped('top.json', kind, isp));
		return raw ? JSON.parse(raw) : null;
	} catch {
		return null;
	}
}

export async function saveTop(kv, ranked, kind = 'entry', isp = 'cf') {
	await kv.put(scoped('top.json', kind, isp), JSON.stringify(ranked));
}

export async function loadMeta(kv, kind = 'entry', isp = 'cf') {
	try {
		const raw = await kv.get(scoped('meta.json', kind, isp));
		return raw ? JSON.parse(raw) : null;
	} catch {
		return null;
	}
}

export async function saveMeta(kv, meta, kind = 'entry', isp = 'cf') {
	await kv.put(scoped('meta.json', kind, isp), JSON.stringify(meta));
}
