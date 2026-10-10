import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeOne, probeBatch, candidatesFromCIDR } from '../src/prober.js';

// mock connect：按 hostname/port 决定建连行为
function makeConnect({ fast = [], slow = [], fail = [], slowMs = 20 } = {}) {
	return ({ hostname, port }) => {
		let open;
		if (fail.includes(hostname)) {
			open = Promise.reject(new Error('refused'));
		} else if (slow.includes(hostname)) {
			open = new Promise((res) => setTimeout(res, slowMs));
		} else {
			open = Promise.resolve();
		}
		return { opened: open, close: async () => { } };
	};
}

test('probeOne: 成功并返回 rtt', async () => {
	const r = await probeOne('1.1.1.1', 443, makeConnect(), { timeoutMs: 500 });
	assert.equal(r.ok, true);
	assert.ok(r.rttMs >= 0);
});

test('probeOne: 连接被拒时失败', async () => {
	const r = await probeOne('9.9.9.9', 443, makeConnect({ fail: ['9.9.9.9'] }), { timeoutMs: 500 });
	assert.equal(r.ok, false);
	assert.equal(r.rttMs, null);
});

test('probeOne: 超过超时判定失败（即使最终会连上）', async () => {
	const r = await probeOne('2.2.2.2', 443,
		makeConnect({ slow: ['2.2.2.2'], slowMs: 300 }),
		{ timeoutMs: 80 });
	assert.equal(r.ok, false);
});

test('probeBatch: 结果顺序与候选一致，含成败', async () => {
	const cands = [
		{ key: 'a:443', hostname: '1.1.1.1', port: 443 },
		{ key: 'b:443', hostname: '9.9.9.9', port: 443 },
	];
	const connect = makeConnect({ fail: ['9.9.9.9'] });
	const res = await probeBatch(cands, connect, { concurrency: 2, at: 1000 });
	assert.equal(res[0].key, 'a:43'.replace('43', '443'));
	assert.equal(res[0].observation.ok, true);
	assert.equal(res[1].observation.ok, false);
	assert.equal(res[0].observation.at, 1000);
});

test('probeBatch: 并发上限生效（100候选/并发5也能跑完）', async () => {
	const cands = Array.from({ length: 100 }, (_, i) =>
		({ key: `10.0.0.${i}:443`, hostname: `10.0.0.${i}`, port: 443 }));
	const res = await probeBatch(cands, makeConnect(), { concurrency: 5 });
	assert.equal(res.length, 100);
	assert.ok(res.every((r) => r.observation.ok));
});

test('candidatesFromCIDR: 在网段内生成候选并去重', () => {
	const c = candidatesFromCIDR(['104.16.0.0/24'], [443, 8443], {
		samplePerCidr: 10, seed: Math.random,
	});
	assert.ok(c.length >= 1);
	const keys = new Set(c.map((x) => x.key));
	assert.equal(keys.size, c.length);
	for (const x of c) {
		const [ip, port] = x.key.split(':');
		const last = parseInt(ip.split('.')[3], 10);
		assert.ok(last >= 1 && last <= 254);
		assert.ok([443, 8443].includes(parseInt(port, 10)));
	}
});

test('candidatesFromCIDR: 受 maxCandidates 限制', () => {
	const c = candidatesFromCIDR(['104.16.0.0/16'], 443, {
		samplePerCidr: 100, maxCandidates: 20,
	});
	assert.equal(c.length, 20);
});
