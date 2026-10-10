/**
 * store: KV 持久化层。把观测表与 top 快照存到 CF KV。
 *
 * kv 由运行时注入（env.KV），形如 CF KV namespace：
 *   get(key) => string|null, put(key, value)
 * 纯 JSON 序列化在本模块，便于注入内存 mock 单测。
 */

const OBS_KEY = 'bestip.observations.json';
const TOP_KEY = 'bestip.top.json';
const META_KEY = 'bestip.meta.json';

/** kind（entry/proxy）前缀，隔离两类链路的存储 */
function prefixed(base, kind) {
	return kind && kind !== 'entry' ? `bestip.${kind}.${base.split('.').slice(1).join('.')}` : base;
}

/** 读取观测表 { key: observations[] } */
export async function loadObservations(kv, kind = 'entry') {
	try {
		const raw = await kv.get(prefixed(OBS_KEY, kind));
		return raw ? JSON.parse(raw) : {};
	} catch {
		return {};
	}
}

/** 写观测表 */
export async function saveObservations(kv, store, kind = 'entry') {
	await kv.put(prefixed(OBS_KEY, kind), JSON.stringify(store));
}

/** 读取 top 快照（ranked 结果） */
export async function loadTop(kv, kind = 'entry') {
	try {
		const raw = await kv.get(prefixed(TOP_KEY, kind));
		return raw ? JSON.parse(raw) : null;
	} catch {
		return null;
	}
}

export async function saveTop(kv, ranked, kind = 'entry') {
	await kv.put(prefixed(TOP_KEY, kind), JSON.stringify(ranked));
}

export async function loadMeta(kv, kind = 'entry') {
	try {
		const raw = await kv.get(prefixed(META_KEY, kind));
		return raw ? JSON.parse(raw) : null;
	} catch {
		return null;
	}
}

export async function saveMeta(kv, meta, kind = 'entry') {
	await kv.put(prefixed(META_KEY, kind), JSON.stringify(meta));
}

export const KEYS = { OBS_KEY, TOP_KEY, META_KEY };
