/**
 * prober: 主动拨测器。并发探测候选节点的 TCP/TLS 建连耗时与可用性。
 *
 * connect 由 Worker 运行时注入（request.fetcher.connect），
 * 形如 (opts) => socket，socket 带可 await 的 `opened` 与 `close()`。
 * 本模块不直接依赖 Workers 运行时，可注入 mock 做单测。
 */

const defaultTiming = () => ({ now: () => Date.now() });

/**
 * 探测单个候选。
 * connect: (opts:{hostname,port}) => socket
 * 返回 { ok, rttMs, error }。
 */
export async function probeOne(hostname, port, connect, { timeoutMs = 3000, timing = defaultTiming() } = {}) {
	const t0 = timing.now();
	let socket;
	try {
		socket = connect({ hostname, port });
	} catch (e) {
		return { ok: false, rttMs: null, error: String(e?.message || e) };
	}

	let timer;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
	});

	try {
		await Promise.race([socket.opened, timeout]);
		return { ok: true, rttMs: Math.max(0, timing.now() - t0), error: null };
	} catch (e) {
		return { ok: false, rttMs: null, error: String(e?.message || e) };
	} finally {
		clearTimeout(timer);
		try { socket?.close?.() } catch { }
	}
}

/**
 * 批量并发探测，带并发上限（避免一次开太多 socket）。
 * candidates: [{ key, hostname, port }]
 * 返回 { key, observation }[]，observation 可直接喂给 core.mergeObservations。
 */
export async function probeBatch(candidates, connect, {
	concurrency = 30, timeoutMs = 3000, at = Date.now(), timing = defaultTiming(),
} = {}) {
	const results = new Array(candidates.length);
	let cursor = 0;

	async function worker() {
		while (cursor < candidates.length) {
			const i = cursor++;
			const c = candidates[i];
			const r = await probeOne(c.hostname, c.port, connect, { timeoutMs, timing });
			results[i] = {
				key: c.key,
				observation: {
					rttMs: r.rttMs,
					ok: r.ok,
					colo: c.colo ?? null,
					at,
				},
			};
		}
	}

	await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, worker));
	return results;
}

/**
 * 从 CIDR 列表生成候选 IP（确定性抽样，便于覆盖 /24 多样性）。
 * 每个 CIDR 取 samplePerCidr 个 IP（随机散列），并分配端口。
 * cidrs: string[]，ports: number[]。
 */
export function candidatesFromCIDR(cidrs, ports, {
	samplePerCidr = 4, maxCandidates = 120, seed = Math.random,
} = {}) {
	const ipToInt = (ip) => ip.split('.').reduce((a, p) => (a << 8) + parseInt(p, 10), 0) >>> 0;
	const intToIp = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');

	const out = [];
	for (const cidr of cidrs) {
		const [base, prefixStr] = cidr.split('/');
		const prefix = parseInt(prefixStr, 10);
		const hostBits = 32 - prefix;
		const baseInt = ipToInt(base);
		const mask = hostBits === 0 ? 0 : (0xFFFFFFFF << hostBits) >>> 0;
		const network = (baseInt & mask) >>> 0;

		for (let s = 0; s < samplePerCidr; s++) {
			let host;
			if (hostBits <= 0) {
				host = 0;
			} else {
				// 随机 host 偏移，避开网络地址与广播
				host = 1 + Math.floor(seed() * (2 ** hostBits - 2));
			}
			const ip = intToIp((network + host) >>> 0);
			const port = Array.isArray(ports)
				? ports[Math.floor(seed() * ports.length)]
				: ports;
			out.push({ key: `${ip}:${port}`, hostname: ip, port });
			if (out.length >= maxCandidates) return dedupe(out);
		}
	}
	return dedupe(out);
}

function dedupe(list) {
	const seen = new Set();
	return list.filter((c) => {
		if (seen.has(c.key)) return false;
		seen.add(c.key);
		return true;
	});
}
