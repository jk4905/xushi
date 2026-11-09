'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {createStore, H, M, KEY, META_KEY} = require('../core/store');
const content = require('../core/content');
const root = path.join(__dirname, '..');
const plain = value => JSON.parse(JSON.stringify(value));
const event = (field, value) => ({currentTarget:{dataset:{field}}, detail:{value}});
const target = id => ({currentTarget:{dataset:{id}}});

function harness() {
  const disk = new Map(), navigation = [], toasts = [], dialogs = [], writes = [];
  disk.set(KEY, JSON.stringify({schemaVersion:2,activeMealId:null,recipes:[],meals:[],menus:[],guests:[]}));
  const faults = {primary:false, metadata:false, clear:false, readback:false};
  let badRead = false;
  const api = {
    getStorageSync(key) {
      if (key === KEY && badRead) { badRead = false; return '{}'; }
      return disk.get(key) || '';
    },
    setStorageSync(key, value) {
      if ((key === KEY && faults.primary) || (key === META_KEY && (faults.metadata || (faults.clear && !Object.keys(JSON.parse(value).drafts).length)))) throw new Error('storage failure');
      disk.set(key, value);
      writes.push(key);
      if (key === KEY && faults.readback) { badRead = true; faults.readback = false; }
    }
  };
  const state = {store:createStore(api), clipboard:null, clipboardFails:false, tab:{}, faults, disk, navigation, toasts, dialogs, writes, api};
  const wx = {
    ...api,
    navigateTo:options => navigation.push({type:'to', ...options}),
    navigateBack:options => navigation.push({type:'back', ...options}),
    switchTab:options => navigation.push({type:'tab', ...options}),
    redirectTo:options => navigation.push({type:'redirect', ...options}),
    showToast:options => toasts.push(options.title),
    showModal:options => dialogs.push(options),
    setClipboardData(options) {
      if (state.clipboardFails) options.fail();
      else { state.clipboard = options.data; options.success(); }
      options.complete();
    }
  };
  const uiContext = {module:{exports:{}}, wx, getCurrentPages:() => [{}, {}]};
  vm.runInNewContext(readFileSync(path.join(root, 'core/ui.js'), 'utf8'), uiContext);
  state.page = (name, options = {}) => {
    let definition;
    vm.runInNewContext(readFileSync(path.join(root, 'pages', name, 'index.js'), 'utf8'), {
      Page:page => { definition = page; }, wx,
      require(name) {
        if (name === '../../core/store') return {store:state.store, H, M};
        if (name === '../../core/ui') return uiContext.module.exports;
        if (name === '../../core/content') return content;
        throw new Error('Unexpected page dependency: ' + name);
      }
    }, {filename:name + '/index.js'});
    const page = {...definition, data:plain(definition.data), setData(values) { Object.assign(this.data, plain(values)); },
      getTabBar:() => ({setData:values => Object.assign(state.tab, values)})};
    page.onLoad?.(options);
    return page;
  };
  state.answer = confirmed => dialogs.shift().success({confirm:confirmed});
  state.store.get();
  return state;
}

function addOwnRecipe(h, name = '家常汤') {
  h.store.commit(H.saveRecipe(h.store.get(), {name, ingredientsText:'番茄｜2个\n水｜一碗', stepsText:'洗净番茄。\n煮成汤。'}));
  return h.store.get().recipes.at(-1);
}

test('saved empty library adds examples explicitly, searches names/materials and routes menu editing', () => {
  const h = harness(), page = h.page('library');
  page.onShow();
  assert.equal(h.tab.active, 'library');
  assert.equal(h.store.get().recipes.length, 0);
  assert.equal(h.writes.length, 0);
  page.addExamples();
  assert.equal(h.store.get().recipes.length, 3);
  assert.equal(h.store.get().meals.length, 0);
  page.onSearch({detail:{value:'培根'}});
  assert.deepEqual(page.data.recipes.map(recipe => recipe.id), ['beef']);
  page.onSearch({detail:{value:'米饭'}});
  assert.deepEqual(page.data.recipes.map(recipe => recipe.id), ['rice']);
  page.onSearch({detail:{value:'无匹配项'}});
  assert.equal(page.data.recipes.length, 0);
  assert.equal(page.data.recipeCount, 3);
  h.store.commit(H.saveMenu(h.store.get(), {title:'周末搭配', recipeIds:['rice', 'broccoli']}));
  page.setSection({currentTarget:{dataset:{section:'menus'}}});
  page.onSearch({detail:{value:'米饭'}});
  assert.equal(page.data.menus.length, 1);
  page.openMenu(target());
  page.openMenu(target('menu-1'));
  page.addRecipe();
  page.openBackup();
  assert.deepEqual(h.navigation.map(item => item.url), ['/pages/builder/index?mode=menu', '/pages/builder/index?mode=menu&menuId=menu-1', '/pages/recipe-edit/index', '/pages/backup/index']);
});

test('menu deletion confirms, preserves meals, and keeps the menu on write failure', async () => {
  const h = harness();
  h.store.addExamples();
  h.store.commit(H.saveMenu(h.store.get(), {title:'晚饭', recipeIds:['rice']}));
  h.store.commit(H.useMenu(h.store.get(), 'menu-1'));
  const page = h.page('library');
  let pending = page.deleteMenu(target('menu-1'));
  await page.deleteMenu(target('menu-1'));
  assert.equal(h.dialogs.length, 1);
  h.answer(false);
  await pending;
  assert.equal(h.store.get().menus.length, 1);
  pending = page.deleteMenu(target('menu-1'));
  h.faults.primary = true;
  h.answer(true);
  await pending;
  assert.equal(h.store.get().menus.length, 1);
  assert.match(page.data.error, /保存/);
  h.faults.primary = false;
  pending = page.deleteMenu(target('menu-1'));
  const added = addOwnRecipe(h);
  h.answer(true);
  await pending;
  assert.equal(h.store.get().menus.length, 0);
  assert.equal(h.store.get().meals.length, 1);
  assert.ok(h.store.get().recipes.some(recipe => recipe.id === added.id));
});

test('recipe renders original steps/images and empty methods, with clipboard failure feedback', () => {
  const h = harness();
  h.store.addExamples();
  const page = h.page('recipe', {id:'beef'});
  page.onShow();
  assert.deepEqual(page.data.steps.map(({title, text}) => ({title, text})), content.seedRecipes[0].steps);
  assert.equal(page.data.steps.length, 10);
  assert.ok(page.data.steps.every(step => step.image));
  page.copySource();
  assert.equal(h.clipboard, 'https://b23.tv/f09s6Nz');
  h.clipboardFails = true;
  page.copySource();
  assert.match(page.data.error, /复制失败/);
  page.editRecipe();
  assert.equal(h.navigation.at(-1).url, '/pages/recipe-edit/index?id=beef');
  const changed = h.store.get();
  changed.recipes[0].steps[0].text = '自己的新做法。';
  h.store.commit(changed);
  page.onShow();
  assert.equal(page.data.steps[0].image, '');
  const rice = h.page('recipe', {id:'rice'});
  rice.onShow();
  assert.deepEqual(rice.data.steps, []);
  const missing = h.page('recipe', {id:'missing'});
  missing.onShow();
  assert.equal(missing.data.recipe, null);
  assert.match(missing.data.error, /不存在/);
});

test('renaming an original recipe retains all material metadata, source URL and step titles on disk', () => {
  const h = harness();
  h.store.addExamples();
  const before = h.store.get().recipes.find(recipe => recipe.id === 'beef');
  const page = h.page('recipe-edit', {id:'beef'});
  page.onInput(event('name', '我的炖牛肉'));
  page.save();
  const after = createStore(h.api).get().recipes.find(recipe => recipe.id === 'beef');
  assert.equal(after.name, '我的炖牛肉');
  assert.equal(after.sourceUrl, before.sourceUrl);
  assert.deepEqual(after.items, before.items.map(item => ({...item,
    dish:item.dish.split('、').map(name => name === before.name ? after.name : name).join('、')
  })));
  assert.deepEqual(after.steps, before.steps);
  assert.equal(h.store.draft('recipe:beef'), null);
  assert.equal(h.navigation.at(-1).type, 'back');
});

test('partial ingredient/step edits retain matched metadata, titles and unique item ids', () => {
  const h = harness(), original = addOwnRecipe(h);
  const household = h.store.get(), recipe = household.recipes[0];
  recipe.items[0] = {...recipe.items[0], choice:'pending', source:'原始记录', note:'确认后再放'};
  recipe.steps[0].title = '准备番茄';
  recipe.steps[1].title = '煮汤';
  h.store.commit(household);
  const before = h.store.get().recipes[0], page = h.page('recipe-edit', {id:original.id});
  page.onInput(event('ingredientsText', '盐｜少许\n水｜一碗\n番茄｜3个'));
  page.onInput(event('stepsText', '准备锅。\n洗净番茄。\n煮成汤。'));
  page.save();
  const after = h.store.get().recipes[0];
  assert.equal(H.validate(h.store.get()), true);
  assert.deepEqual(after.items[1], before.items[1]);
  assert.deepEqual(after.items[2], {...before.items[0], quantity:'3个'});
  assert.deepEqual(after.steps.slice(1), before.steps);
  assert.equal(new Set(after.items.map(item => item.id)).size, 3);
});

test('renaming updates only this recipe name in shared dish attribution and keeps existing meals intact', () => {
  const h = harness(), original = addOwnRecipe(h);
  const household = h.store.get();
  household.recipes[0].items[0].dish = '家常汤、凉拌番茄';
  household.recipes[0].items[0].note = '两道菜共用，留一半';
  h.store.commit(H.createMeal(household, {title:'原来的一餐', recipeIds:[original.id]}));
  const before = h.store.get(), page = h.page('recipe-edit', {id:original.id});
  page.onInput(event('name', '家庭番茄汤'));
  page.save();
  const after = h.store.get();
  assert.equal(after.recipes[0].items[0].dish, '家庭番茄汤、凉拌番茄');
  assert.equal(after.recipes[0].items[1].dish, '家庭番茄汤');
  assert.deepEqual(after.recipes[0].items[0], {...before.recipes[0].items[0], dish:'家庭番茄汤、凉拌番茄'});
  assert.deepEqual(after.meals, before.meals);
  assert.equal(H.validate(after), true);
});

test('new/id drafts recover separately and metadata write failures leave input available', () => {
  const h = harness(), original = addOwnRecipe(h);
  const fresh = h.page('recipe-edit'), editing = h.page('recipe-edit', {id:original.id});
  fresh.onInput(event('name', '新菜草稿'));
  editing.onInput(event('name', '已有菜草稿'));
  assert.equal(h.page('recipe-edit').data.name, '新菜草稿');
  assert.equal(h.page('recipe-edit', {id:original.id}).data.name, '已有菜草稿');
  h.faults.metadata = true;
  fresh.onInput(event('sourceUrl', 'https://example.com/recipe'));
  assert.equal(fresh.data.sourceUrl, 'https://example.com/recipe');
  assert.match(fresh.data.error, /保存/);
  assert.equal(h.page('recipe-edit').data.sourceUrl, fresh.data.sourceUrl);
  fresh.onFocus();
  assert.equal(fresh.data.keyboardOpen, true);
  fresh.onKeyboardHeightChange({detail:{height:0}});
  assert.equal(fresh.data.keyboardOpen, false);
  fresh.save();
  assert.equal(h.store.get().recipes.length, 2);
  assert.equal(h.navigation.at(-1).type, 'back');
});

test('validation and main write/readback failures stay on page; retries and double taps add once', () => {
  for (const failure of ['primary', 'readback']) {
    const h = harness(), page = h.page('recipe-edit');
    page.onInput(event('name', '一道菜'));
    page.onInput(event('sourceUrl', 'javascript:alert(1)'));
    page.save();
    assert.equal(h.navigation.length, 0);
    assert.equal(h.store.get().recipes.length, 0);
    assert.match(page.data.error, /HTTP/);
    page.onInput(event('sourceUrl', 'https://example.com/dish'));
    h.faults[failure] = true;
    page.save();
    assert.equal(page.data.saving, false);
    assert.equal(page.data.name, '一道菜');
    assert.equal(h.navigation.length, 0);
    assert.equal(h.store.get().recipes.length, 0);
    h.faults[failure] = false;
    page.save();
    page.save();
    assert.equal(createStore(h.api).get().recipes.length, 1);
    assert.equal(h.navigation.length, 1);
    assert.equal(page.data.saved, true);
  }
});

test('clearDraft failure after commit still returns, locks saving first and recovers the committed id after restart', () => {
  const h = harness(), page = h.page('recipe-edit');
  page.onInput(event('name', '无链接菜谱'));
  page.onInput(event('ingredientsText', '米｜一杯'));
  h.faults.clear = true;
  const clear = h.store.clearDraft;
  h.store.clearDraft = key => {
    assert.equal(page.data.saved, true);
    assert.equal(page.data.recipeId, 'recipe-1');
    page.save();
    clear(key);
  };
  page.save();
  page.onUnload();
  page.save();
  assert.equal(h.writes.filter(key => key === KEY).length, 1);
  assert.equal(h.navigation.at(-1).type, 'back');
  assert.match(h.toasts.at(-1), /已保存.*草稿清理失败/);
  h.store = createStore(h.api);
  const resumed = h.page('recipe-edit');
  assert.equal(resumed.data.recipeId, 'recipe-1');
  resumed.onInput(event('name', '改个菜名'));
  h.faults.clear = false;
  resumed.save();
  assert.equal(h.store.get().recipes.length, 1);
  assert.equal(h.store.get().recipes[0].name, '改个菜名');
});

test('duplicate source links retain differing user input and only return when it matches', () => {
  const h = harness();
  h.store.commit(H.saveRecipe(h.store.get(), {name:'先存的菜', sourceUrl:'https://example.com/dish'}));
  const before = h.store.get(), page = h.page('recipe-edit');
  page.onInput(event('name', '后写的菜名'));
  page.onInput(event('sourceUrl', 'https://example.com/dish'));
  page.save();
  assert.deepEqual(h.store.get(), before);
  assert.equal(page.data.name, '后写的菜名');
  assert.match(page.data.error, /本次输入.*不同/);
  assert.equal(h.navigation.length, 0);
  assert.equal(h.store.draft('recipe:new').name, '后写的菜名');
  page.onInput(event('name', '先存的菜'));
  page.onInput(event('ingredientsText', '米｜一杯'));
  page.save();
  assert.match(page.data.error, /本次输入.*不同/);
  assert.equal(h.navigation.length, 0);
  assert.deepEqual(h.store.get(), before);
  page.onInput(event('ingredientsText', ''));
  page.save();
  assert.equal(h.toasts.at(-1), '该链接已在菜谱中');
  assert.equal(h.navigation.at(-1).type, 'back');
});

test('failed receipt persistence cannot silently overwrite a matching recipe from an older draft', () => {
  const h = harness(), page = h.page('recipe-edit');
  page.onInput(event('name', '原稿菜谱'));
  page.onInput(event('ingredientsText', '米｜一杯'));
  h.faults.metadata = true;
  page.save();
  const before = h.store.get();
  assert.equal(before.recipes.length, 1);
  h.store = createStore(h.api);
  const restored = h.page('recipe-edit');
  assert.equal(restored.data.recipeId, '');
  restored.onInput(event('ingredientsText', '米｜两杯'));
  restored.save();
  assert.match(restored.data.error, /同名/);
  assert.equal(restored.data.ingredientsText, '米｜两杯');
  assert.deepEqual(h.store.get(), before);
  assert.equal(h.navigation.length, 1);
});

test('stale drafts cannot overwrite newer recipe edits; discarding restores current values', async () => {
  const h = harness(), original = addOwnRecipe(h), page = h.page('recipe-edit', {id:original.id});
  page.onInput(event('name', '旧草稿菜名'));
  const newer = h.store.get();
  newer.recipes[0].name = '新的菜名';
  h.store.commit(newer);
  page.save();
  assert.match(page.data.error, /原菜谱已更新/);
  assert.equal(h.store.get().recipes[0].name, '新的菜名');
  assert.equal(h.navigation.length, 0);
  const discarded = page.discardDraft();
  h.answer(true);
  await discarded;
  assert.equal(page.data.name, '新的菜名');
});
