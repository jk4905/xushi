'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const filename = path.join(__dirname, '../components/app-tabs/index.js');
const directions = [['home', 'library'], ['library', 'home']];
const route = tab => 'pages/' + tab + '/index';
const tap = (instance, tab) => instance.go({currentTarget:{dataset:{tab}}});

function harness(initial = 'home') {
  const h = {route:route(initial), now:1000, navigation:[], toasts:[]};
  const keyboards = new Set();
  let definition;
  // Load once per test scenario so every instance shares the real module closure.
  vm.runInNewContext(readFileSync(filename, 'utf8'), {
    Component:value => { definition = value; },
    Date:class extends Date { static now() { return h.now; } },
    getCurrentPages:() => h.route ? [{route:h.route}] : [],
    wx:{
      switchTab:options => h.navigation.push(options),
      showToast:options => h.toasts.push(options.title),
      onKeyboardHeightChange:listener => keyboards.add(listener),
      offKeyboardHeightChange:listener => keyboards.delete(listener)
    }
  }, {filename});
  h.component = (active = definition.properties.active.value) => ({
    ...definition.methods,
    data:{...structuredClone(definition.data), active},
    setData(patch) { Object.assign(this.data, structuredClone(patch)); },
    attached() { definition.lifetimes.attached.call(this); },
    detached() { definition.lifetimes.detached.call(this); },
    show() { definition.pageLifetimes.show.call(this); },
    hide() { definition.pageLifetimes.hide.call(this); },
    observe() { definition.observers.active.call(this, this.data.active); },
    setActive(value) { this.setData({active:value}); this.observe(); }
  });
  h.keyboard = height => keyboards.forEach(listener => listener({height}));
  return h;
}

function arrive(h, source, destination, delay = 0) {
  source.hide();
  h.now += delay;
  h.route = route(destination.data.active);
  destination.show();
}

test('first appearance and ordinary returns never navigate or replay a slide', () => {
  for (const [tab] of directions) {
    const h = harness(tab), instance = h.component(tab);
    instance.attached();
    instance.show();
    instance.observe();
    assert.equal(instance.data.slideFrom, '');
    instance.hide();
    h.route = 'pages/recipe/index';
    h.route = route(tab);
    instance.show();
    instance.observe();
    assert.equal(instance.data.slideFrom, '');
    assert.equal(instance.data.active, tab);
    assert.equal(h.navigation.length, 0);
  }
});

test('switchTab is immediate; only the destination root consumes the shared direction once', () => {
  for (const [from, to] of directions) {
    const h = harness(from), source = h.component(from), destination = h.component(from);
    source.attached();
    destination.attached();
    tap(source, to);
    assert.deepEqual(h.navigation.map(call => call.url), ['/' + route(to)]);
    assert.equal(source.data.active, from);
    assert.equal(source.data.slideFrom, '');
    destination.setActive(to);
    destination.show();
    assert.equal(destination.data.slideFrom, '', 'an offscreen observer must not consume the direction');
    h.route = route(to);
    source.observe();
    assert.equal(source.data.slideFrom, '', 'the source instance must not consume the direction');
    arrive(h, source, destination, 20);
    assert.equal(destination.data.active, to);
    assert.equal(destination.data.slideFrom, from);
    assert.equal(destination.data.slideDelay, 20);
    assert.equal(source.data.slideFrom, '');
    destination.slideEnd();
    destination.show();
    destination.observe();
    assert.equal(destination.data.slideFrom, '', 'a consumed transition must not replay');
    assert.equal(h.navigation.length, 1);
  }
});

test('attached/show/active observer ordering and repetition preserve a just-started slide', () => {
  for (const [from, to] of directions) {
    for (const order of [['attached', 'show', 'observe'], ['show', 'observe', 'attached'], ['observe', 'attached', 'show']]) {
      const h = harness(from), source = h.component(from), destination = h.component(to);
      tap(source, to);
      h.now += 12;
      h.route = route(to);
      destination[order[0]]();
      assert.equal(destination.data.slideFrom, from);
      assert.equal(destination.data.slideDelay, 12);
      for (const hook of [...order, 'show', 'observe']) {
        h.now += 5;
        destination[hook]();
        assert.equal(destination.data.slideFrom, from, order.join('/') + ': ' + hook);
        assert.equal(destination.data.slideDelay, 12, 'duplicate lifecycle calls must not restart progress');
      }
      assert.equal(h.navigation.length, 1);
    }
  }
});

test('current root clicks do nothing; subpage clicks return to their tab root without sliding', () => {
  for (const [tab, child] of [['home', 'shopping'], ['library', 'recipe']]) {
    const h = harness(tab), root = h.component(tab), subpage = h.component(tab);
    root.attached();
    tap(root, tab);
    tap(root, tab);
    assert.equal(h.navigation.length, 0);
    h.route = route(child);
    subpage.attached();
    tap(subpage, tab);
    assert.deepEqual(h.navigation.map(call => call.url), ['/' + route(tab)]);
    assert.equal(subpage.data.slideFrom, '');
    arrive(h, subpage, root);
    assert.equal(root.data.slideFrom, '');
    tap(root, tab);
    assert.equal(h.navigation.length, 1);
  }
});

test('duplicate pending destinations navigate once and a reverse choice supersedes the pending switch', () => {
  for (const [from, to] of directions) {
    const h = harness(from), source = h.component(from), destination = h.component(to);
    tap(source, to);
    tap(source, to);
    assert.equal(h.navigation.length, 1);
    tap(source, from);
    tap(source, from);
    assert.deepEqual(h.navigation.map(call => call.url), ['/' + route(to), '/' + route(from)]);
    assert.equal(source.data.active, from);
    destination.show();
    source.show();
    assert.equal(source.data.slideFrom, '', 'returning to the still-selected root needs no horizontal slide');
    assert.equal(destination.data.slideFrom, '');
    tap(source, from);
    assert.equal(h.navigation.length, 2);
  }
});

test('old failures cannot erase a newer direction, even when old and new destinations match', () => {
  const h = harness(), home = h.component('home'), library = h.component('library');
  tap(home, 'library');
  tap(home, 'home');
  tap(home, 'library');
  assert.deepEqual(h.navigation.map(call => call.url), ['/pages/library/index', '/pages/home/index', '/pages/library/index']);
  h.navigation[0].fail();
  assert.deepEqual(h.toasts, []);
  arrive(h, home, library, 15);
  assert.equal(library.data.slideFrom, 'home');
  assert.equal(library.data.slideDelay, 15);
  h.navigation[1].fail();
  assert.equal(library.data.slideFrom, 'home');
  assert.deepEqual(h.toasts, []);
});

test('a failed current request keeps the selected tab, clears the pending slide and permits retry', () => {
  for (const [from, to] of directions) {
    const h = harness(from), source = h.component(from), destination = h.component(to);
    tap(source, to);
    h.navigation[0].fail();
    assert.equal(source.data.active, from);
    assert.equal(source.data.slideFrom, '');
    assert.equal(h.toasts.length, 1);
    assert.match(h.toasts[0], /失败.*重试/);
    h.route = route(to);
    destination.show();
    assert.equal(destination.data.slideFrom, '', 'a failed request must not animate a later ordinary visit');
    h.route = route(from);
    tap(source, to);
    assert.deepEqual(h.navigation.map(call => call.url), ['/' + route(to), '/' + route(to)]);
    arrive(h, source, destination);
    assert.equal(destination.data.slideFrom, from);
    assert.equal(destination.data.active, to);
  }
});

test('page hide and keyboard hiding clear an unfinished slide without replay on return', () => {
  for (const [from, to] of directions) {
    for (const interruption of ['hide', 'keyboard']) {
      const h = harness(from), source = h.component(from), destination = h.component(to);
      source.attached();
      destination.attached();
      tap(source, to);
      arrive(h, source, destination, 20);
      assert.equal(destination.data.slideFrom, from);
      h.now += 30;
      if (interruption === 'hide') {
        destination.hide();
        h.route = 'pages/recipe/index';
      } else {
        h.keyboard(280);
        assert.equal(destination.data.keyboardOpen, true);
      }
      assert.equal(destination.data.slideFrom, '');
      h.now += 10;
      h.route = route(to);
      if (interruption === 'keyboard') h.keyboard(0);
      destination.show();
      destination.observe();
      assert.equal(destination.data.keyboardOpen, false);
      assert.equal(destination.data.slideFrom, '', 'no animationend event is needed to prevent replay');
      assert.equal(h.navigation.length, 1);
      source.detached();
      destination.detached();
      h.keyboard(280);
      assert.equal(destination.data.keyboardOpen, false, 'detached instances must unsubscribe');
    }
  }
});

test('invalid tabs never navigate or replace a valid pending direction', () => {
  const h = harness(), home = h.component('home'), library = h.component('library');
  const invalid = [undefined, null, '', 'recipe', 'HOME', '../home', 'constructor', 0, {}];
  for (const tab of invalid) tap(home, tab);
  assert.equal(h.navigation.length, 0);
  tap(home, 'library');
  for (const tab of invalid) tap(home, tab);
  assert.equal(h.navigation.length, 1);
  assert.deepEqual(h.toasts, []);
  arrive(h, home, library);
  assert.equal(library.data.slideFrom, 'home');
});

test('mid-slide reversals preserve progress plus navigation time; slow navigation never replays', () => {
  const h = harness(), home = h.component('home'), library = h.component('library');
  tap(home, 'library');
  arrive(h, home, library, 30);
  assert.equal(library.data.slideDelay, 30);
  h.now += 50;
  tap(library, 'home');
  assert.equal(h.navigation.length, 2, 'reverse navigation must not wait for animationend');
  arrive(h, library, home, 10);
  assert.equal(home.data.slideFrom, 'library');
  assert.equal(home.data.slideDelay, 170, '240 - (30 + 50) elapsed + 10 navigation');
  h.now += 20;
  tap(home, 'library');
  arrive(h, home, library, 5);
  assert.equal(library.data.slideFrom, 'home');
  assert.equal(library.data.slideDelay, 55, '240 - (170 + 20) elapsed + 5 navigation');
  assert.equal(h.navigation.length, 3);

  for (const [from, to] of directions) {
    for (const delay of [240, 300]) {
      const slow = harness(from), source = slow.component(from), destination = slow.component(to);
      tap(source, to);
      assert.equal(slow.navigation.length, 1);
      arrive(slow, source, destination, delay);
      assert.equal(destination.data.active, to);
      assert.equal(destination.data.slideFrom, '', 'navigation at or beyond 240ms must arrive at the endpoint');
      destination.attached();
      destination.observe();
      destination.show();
      assert.equal(destination.data.slideFrom, '');
      assert.equal(slow.navigation.length, 1);
    }
  }
});
