import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	decayFactor, summarize, scoreNode, rankNodes,
	mergeObservations, pickTop, HALF_LIFE_MS,
} from '../src/core.js';

const NOW = 1_800_000_000_000;

test('decayFactor: 半衰期处应为 0.5', () => {
	assert.equal(decayFactor(HALF_LIFE_MS, HALF_LIFE_MS), 0.5);
	assert.equal(decayFactor(0), 1);
	assert.ok(decayFactor(HALF_LIFE_MS * 2) < 0.26);
});

test('summarize: 加权平均延迟与失败率', () => {
	const obs = [
		{ rttMs: 100, ok: true, at: NOW },
		{ rttMs: 200, ok: true, at: NOW },
		{ rttMs: null, ok: false, at: NOW },
	];
	const s = summarize(obs, NOW);
	assert.equal(s.samples, 3);
	assert.ok(Math.abs(s.meanRtt - 150) < 1);
	assert.ok(Math.abs(s.failRate - 1 / 3) < 0.01);
	assert.ok(s.jitter >= 0);
});

test('summarize: 旧观测权重应更低', () => {
	// 新观测权重1(rtt100)，旧观测权重0.5(rtt400)
	// 均值 = (100*1 + 400*0.5)/1.5 = 200；若不衰减则为 250。
	const obs = [
		{ rttMs: 100, ok: true, at: NOW },
		{ rttMs: 400, ok: true, at: NOW - HALF_LIFE_MS },
	];
	const s = summarize(obs, NOW);
	assert.ok(Math.abs(s.meanRtt - 200) < 1, `mean ${s.meanRtt}`);
	assert.ok(s.meanRtt < 250, '衰减后应低于无加权均值250');
});

test('scoreNode: 全失败节点分数应很低', () => {
	const s = summarize([{ rttMs: null, ok: false, at: NOW }], NOW);
	assert.ok(scoreNode(s, undefined, NOW) < 15);
});

test('scoreNode: 低延迟稳定节点分数应高', () => {
	const obs = Array.from({ length: 8 }, (_, i) =>
		({ rttMs: 80 + (i % 3) * 5, ok: true, colo: 'NRT', at: NOW - i }));
	const s = summarize(obs, NOW);
	const score = scoreNode(s, undefined, NOW);
	assert.ok(score > 60, `score ${score} 应较高`);
});

test('rankNodes: 好节点排在坏节点前', () => {
	const good = Array.from({ length: 8 }, (_, i) =>
		({ rttMs: 60, ok: true, colo: 'HKG', at: NOW - i }));
	const bad = [{ rttMs: null, ok: false, at: NOW }];
	const ranked = rankNodes([
		{ key: 'bad', observations: bad },
		{ key: 'good', observations: good },
	], { now: NOW });
	assert.equal(ranked[0].key, 'good');
	assert.equal(ranked[ranked.length - 1].key, 'bad');
});

test('mergeObservations: 增量合并且有界', () => {
	let store = {};
	for (let i = 0; i < 70; i++) {
		store = mergeObservations(store,
			[{ key: 'a', observation: { rttMs: i, ok: true, at: NOW + i } }],
			{ maxPerNode: 64, now: NOW });
	}
	assert.equal(store.a.length, 64);
	assert.equal(store.a[store.a.length - 1].rttMs, 69);
});

test('pickTop: 无合格节点时返回 null（应回退实时竞速）', () => {
	const ranked = rankNodes([
		{ key: 'x', observations: [{ rttMs: null, ok: false, at: NOW }] },
	], { now: NOW });
	assert.equal(pickTop(ranked), null);
});

test('pickTop: 返回达到阈值的最佳节点', () => {
	const good = Array.from({ length: 8 }, () =>
		({ rttMs: 50, ok: true, at: NOW }));
	const ranked = rankNodes([{ key: 'g', observations: good }], { now: NOW });
	assert.ok(pickTop(ranked));
	assert.equal(pickTop(ranked).key, 'g');
});
