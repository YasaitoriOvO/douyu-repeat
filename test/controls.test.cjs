const { test } = require('node:test');
const assert = require('node:assert/strict');
const { editorKind, editorText, writeEditor, fillsViewport } = require('../douyu-repeat.user.js');
test('识别标准及富文本编辑器，拒绝普通容器和非文本 input', () => {
  assert.equal(editorKind({ tagName: 'TEXTAREA' }), 'value');
  assert.equal(editorKind({ tagName: 'INPUT', type: 'text' }), 'value');
  assert.equal(editorKind({ tagName: 'INPUT', type: 'checkbox' }), null);
  assert.equal(editorKind({ tagName: 'DIV', isContentEditable: true }), 'editable');
  assert.equal(editorKind({ tagName: 'DIV' }), null);
  assert.equal(editorKind(null), null);
});
test('富文本读取忽略占位空白，但保留用户草稿', () => {
  assert.equal(editorText({ isContentEditable: true, textContent: '\u200B\n' }), '');
  assert.equal(editorText({ isContentEditable: true, textContent: '手动草稿' }), '手动草稿');
  assert.equal(editorText({ tagName: 'TEXTAREA', value: '草稿' }), '草稿');
});
test('富文本写入使用纯文本并派发输入事件', () => {
  const original = global.InputEvent;
  global.InputEvent = class extends Event { constructor(type, options) { super(type, options); this.data = options.data; } };
  try {
    const events = [];
    const element = { isContentEditable: true, textContent: '', dispatchEvent: event => events.push(event) };
    writeEditor(element, '<b>弹幕</b>');
    assert.equal(element.textContent, '<b>弹幕</b>');
    assert.deepEqual(events.map(event => event.type), ['input', 'change']);
    assert.equal(events[0].bubbles, true);
  } finally { if (original === undefined) delete global.InputEvent; else global.InputEvent = original; }
});
test('网页全屏范围识别，普通和偏移播放器不误判', () => {
  assert.equal(fillsViewport({ width: 1920, height: 1080, left: 0, top: 0 }, 1920, 1080), true);
  assert.equal(fillsViewport({ width: 1000, height: 600, left: 100, top: 50 }, 1920, 1080), false);
  assert.equal(fillsViewport({ width: 1920, height: 1080, left: 0, top: 300 }, 1920, 1080), false);
});
