const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Counter, defaults, composeMessage } = require('../douyu-repeat.user.js');
test('句末词默认空，直接追加到原弹幕，原文及最终消息均可进入冷却', () => {
  assert.equal(defaults.suffix, '');
  assert.equal(composeMessage('好耶', defaults.suffix), '好耶');
  assert.equal(composeMessage('好耶', '喵🐷'), '好耶喵🐷');
  const c = new Counter(defaults);
  c.mark('好耶', 0); c.mark(composeMessage('好耶', '喵'), 0);
  c.add('好耶', '甲', 1); c.add('好耶喵', '自己', 1);
  assert.equal(c.top(1).length, 0);
});
const create = extra => new Counter({ ...defaults, ...extra });
test('同一观众不能刷到人数阈值；不同观众达到阈值', () => {
  const c = create();
  for (let i = 0; i < 20; i++) c.add('哈哈', '甲', i);
  assert.equal(c.candidate(20), null);
  for (const name of ['乙', '丙', '丁', '戊']) c.add('哈哈', name, 21);
  assert.equal(c.candidate(22).users.size, 5);
});
test('窗口过期的观众不计数', () => {
  const c = create({ threshold: 2 });
  c.add('哈哈', '甲', 0); c.add('哈哈', '乙', 30000);
  assert.equal(c.candidate(30000), null);
});
test('全局发送间隔以及同句冷却独立生效', () => {
  const c = create({ threshold: 2 });
  c.mark('哈哈', 0);
  for (const name of ['甲', '乙']) { c.add('哈哈', name, 1000); c.add('好耶', name, 1000); }
  assert.equal(c.candidate(1000), null);
  assert.equal(c.candidate(30000).text, '好耶');
  for (const name of ['甲', '乙']) c.add('哈哈', name, 300000);
  assert.equal(c.candidate(300000).text, '哈哈');
});
test('过滤自己的昵称、广告、空消息、过长内容', () => {
  const c = create({ ownName: '我', maxLength: 5, blocked: 'http' });
  for (const [text, name] of [['哈哈', '我'], ['HTTP', '甲'], ['123456', '甲'], [' ', '甲'], ['哈哈', '']]) c.add(text, name, 0);
  assert.equal(c.top(0).length, 0);
});
test('全半角和空白归一化，冷却期间自己的回显不再进入统计', () => {
  const c = create({ threshold: 2 });
  c.add('Ａ  B', '甲', 0); c.add('A B', '乙', 0);
  assert.equal(c.candidate(0).text, 'A B');
  c.mark('A B', 1); c.add('Ａ B', '自己', 2);
  assert.equal(c.top(2).length, 0);
});
test('切换房间用新的计数器隔离旧弹幕', () => {
  const old = create({ threshold: 2 }); old.add('哈哈', '甲', 0); old.add('哈哈', '乙', 0);
  assert.ok(old.candidate(0)); assert.equal(create().candidate(0), null);
});
test('默认黑名单模式、空白名单；黑名单仅排除命中内容', () => {
  assert.equal(defaults.filterMode, 'blacklist'); assert.equal(defaults.whitelist, '');
  const c = create({ blocked: '广告，http', whitelist: '不会命中' });
  c.add('HTTP链接', '甲', 0); c.add('一个广告', '乙', 0); c.add('好耶', '丙', 0);
  assert.deepEqual(c.top(0).map(x => x.text), ['好耶']);
});
test('白名单按包含匹配，支持换行、全半角与大小写；不应用黑名单', () => {
  const c = create({ filterMode: 'whitelist', whitelist: '好耶\nＡＢＣ，精彩', blocked: '好耶' });
  c.add('好耶！', '甲', 0); c.add('abc!', '乙', 0); c.add('真精彩', '丙', 0); c.add('路过', '丁', 0);
  assert.deepEqual(c.top(0).map(x => x.text), ['好耶!', 'abc!', '真精彩']);
});
test('空白名单不接受任何弹幕，空黑名单允许正常弹幕', () => {
  const white = create({ filterMode: 'whitelist', whitelist: ' ,，\n ' });
  white.add('好耶', '甲', 0); assert.equal(white.top(0).length, 0);
  const black = create({ blocked: '' }); black.add('好耶', '甲', 0); assert.equal(black.top(0).length, 1);
});
