import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runOptimization, selectBest, reportOutcome } from '../src/orchestrator.js';

function memKV() {
	const m = new Map();
	return {
		get: async (k) => (m.has(k) ? m.get(k) : null),
		put: async (k, v) => { m.set(k, v); },
		_dump: m,
	};
}

// connect：让 IP 末位决定延迟，奇数末位失败
function makeConnect() {
	return ({ hostname }) => {
		const last = parseInt(hostname.split('.')[3], 10);
		const open = last % 2 === 0 ? Promise.resolve() : Promise.reject(new Error('refused'));
		return { opened: open, close: async () => { } };
	};
}

test('runOptimization: 完成闭环并写 KV', async () => {
	const kv = memKV();
	const r = await runOptimization({
		connect: makeConnect(), kv,
		cidrs: ['104.16.0.0/24'],
		kind: 'entry',
	}, { samplePerCidr: 20, maxCandidates: 40, ports: [443] });

	assert.ok(r.candidates >= 1);
	assert.ok(r.ranked.length >= 1);
	assert.ok(kv._dump.has('bestip.observations.json'));
	assert.ok(kv._dump.has('bestip.top.json'));
	assert.ok(kv._dump.has('bestip.meta.json'));
	// 排序第一应是成功节点（偶数末位）
	if (r.ranked[0].stats.meanRtt !== null) {
		const last = parseInt(r.ranked[0].key.split('.')[3], 10);
		assert.equal(last % 2, 0);
	}
});

test('kind 隔离：entry/proxy 分开存储', async () => {
	const kv = memKV();
	await runOptimization({
		connect: makeConnect(), kv, cidrs: ['104.16.0.0/24'], kind: 'entry',
	}, { samplePerCidr: 6, ports: [443] });
	await runOptimization({
		connect: makeConnect(), kv, cidrs: ['104.16.0.0/24'], kind: 'proxy',
	}, { samplePerCidr: 6, ports: [443] });
	assert.ok(kv._dump.has('bestip.observations.json'));
	assert.ok(kv._dump.has('bestip.proxy.observations.json'));
});

test('selectBest: 优选后能选出节点；冷启动返回 null', async () => {
	const cold = memKV();
	assert.equal(await selectBest(cold, { kind: 'entry' }), null);

	const kv = memKV();
	await runOptimization({
		connect: makeConnect(), kv, cidrs: ['104.16.0.0/24'], kind: 'entry',
	}, { samplePerCidr: 30, ports: [443] });
	const top = await selectBest(kv, { kind: 'entry', minScore: 1 });
	assert.ok(top, '应有合格节点');
	assert.ok(top.key.endsWith(':443'));
});

test('reportOutcome: 真实结果并入评分', async () => {
	const kv = memKV();
	await reportOutcome(kv, { key: '1.1.1.1:443', ok: true, rttMs: 40 }, { kind: 'entry' });
	const raw = JSON.parse(kv._dump.get('bestip.observations.json'));
	assert.equal(raw['1.1.1.1:443'].length, 1);
	assert.equal(raw['1.1.1.1:443'][0].ok, true);
});

test('runOptimization: 缺依赖应报错', async () => {
	await assert.rejects(() => runOptimization({
		connect: null, kv: memKV(), cidrs: ['10.0.0.0/24'],
	}), /missing connect/);
	await assert.rejects(() => runOptimization({
		connect: makeConnect(), kv: null, cidrs: ['10.0.0.0/24'],
	}), /missing kv/);
});
