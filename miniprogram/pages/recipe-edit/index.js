'use strict';
const {store, H} = require('../../core/store');
const ui = require('../../core/ui');
const fields = ['name', 'sourceUrl', 'ingredientsText', 'stepsText'];
const formFields = value => fields.reduce((form, field) => { form[field] = value[field]; return form; }, {});
const formFor = recipe => ({
  name:recipe?.name || '', sourceUrl:recipe?.sourceUrl || '',
  ingredientsText:recipe?.items.map(item => item.name + (item.quantity ? '｜' + item.quantity : '')).join('\n') || '',
  stepsText:recipe?.steps.map(step => step.text).join('\n') || ''
});

function preserveDetails(previous, recipe, form) {
  if (form.ingredientsText === formFor(previous).ingredientsText) recipe.items = previous.items;
  else {
    const unmatched = previous.items.slice(), ids = new Set(previous.items.map(item => item.id));
    let number = 1;
    recipe.items = recipe.items.map(item => {
      let index = unmatched.findIndex(old => old.name === item.name && old.quantity === item.quantity);
      if (index < 0) index = unmatched.findIndex(old => old.name === item.name);
      if (index >= 0) return {...unmatched.splice(index, 1)[0], quantity:item.quantity};
      while (ids.has(item.id)) item.id = 'ingredient-' + number++;
      ids.add(item.id);
      return item;
    });
  }
  if (recipe.name !== previous.name) recipe.items = recipe.items.map(item => ({...item,
    dish:item.dish.split('、').map(name => name.trim() === previous.name.trim() ? recipe.name : name).join('、')
  }));
  if (form.stepsText === formFor(previous).stepsText) recipe.steps = previous.steps;
  else {
    const unmatched = previous.steps.slice();
    recipe.steps = recipe.steps.map(step => {
      const index = unmatched.findIndex(old => old.text === step.text);
      return index < 0 ? step : unmatched.splice(index, 1)[0];
    });
  }
}

Page({
  data: {...formFor(null), recipeId:'', expanded:false, keyboardOpen:false, ready:false, saved:false, draftStatus:'', error:'', saving:false},
  onLoad(options) {
    this._recipeId = options.id || '';
    this._draftKey = 'recipe:' + (this._recipeId || 'new');
    this.loadForm();
  },
  loadForm() {
    try {
      const household = store.get();
      let recipe = household.recipes.find(item => item.id === this._recipeId);
      if (this._recipeId && !recipe) throw new Error('这道菜谱已不存在，请返回后重新选择。');
      const draft = store.draft(this._draftKey);
      if (draft && (!fields.every(field => typeof draft[field] === 'string') || typeof draft.base !== 'string')) {
        throw new Error('这份草稿无法读取，可放弃草稿后重新填写。');
      }
      // A persisted receipt also prevents a leftover new draft from adding the saved recipe again.
      const committed = draft?.pending && household.recipes.find(item => item.id === draft.pending.id && JSON.stringify(item) === draft.pending.value);
      if (committed) { recipe = committed; this._recipeId = committed.id; }
      this._base = committed ? JSON.stringify(recipe) : draft ? draft.base : recipe ? JSON.stringify(recipe) : '';
      this._pending = draft?.pending || null;
      const form = draft ? formFields(draft) : formFor(recipe);
      this.setData({...form, recipeId:this._recipeId, ready:true, expanded:draft ? !!draft.expanded : !!(recipe?.items.length || recipe?.steps.length),
        draftStatus:draft ? '已恢复上次的草稿。' : '', error:''});
    } catch (error) { this.setData({ready:false}); ui.error(this, error); }
  },
  onInput(event) {
    const field = event.currentTarget.dataset.field;
    if (!fields.includes(field) || this._saving || this._finished) return;
    this.setData({[field]:event.detail.value, error:''});
    this.persistDraft();
  },
  toggleDetails() {
    this.setData({expanded:!this.data.expanded});
    this.persistDraft();
  },
  onFocus() { this.setData({keyboardOpen:true}); },
  onKeyboardHeightChange(event) { this.setData({keyboardOpen:event.detail.height > 0}); },
  persistDraft() {
    if (!this.data.ready || this._finished) return;
    try {
      store.saveDraft(this._draftKey, {...formFields(this.data),
        base:this._base, pending:this._pending, expanded:this.data.expanded});
      this.setData({draftStatus:'草稿已保存在本机，可稍后继续。'});
    } catch (error) {
      this.setData({draftStatus:'草稿尚未存到本机，当前输入仍保留，请稍后重试。', error:error.message});
    }
  },
  onHide() { this.persistDraft(); },
  onUnload() { this.persistDraft(); },
  async discardDraft() {
    if (this._saving || this._finished) return;
    if (!await ui.confirm({title:'放弃这份草稿', content:'未保存的输入将被放弃，已保存的菜谱会保留。', confirmText:'放弃草稿'})) return;
    try { store.clearDraft(this._draftKey); this.loadForm(); }
    catch (error) { ui.error(this, error); }
  },
  save() {
    if (this._saving || this._finished || !this.data.ready) return;
    this._saving = true;
    this.setData({saving:true, error:''});
    let duplicate = false;
    try {
      const household = store.get(), previous = household.recipes.find(item => item.id === this._recipeId);
      if (this._recipeId && !previous) throw new Error('原菜谱已不存在，输入仍保留，请返回核对。');
      if (this._base !== (previous ? JSON.stringify(previous) : '')) throw new Error('原菜谱已更新。输入仍保留，请先核对；放弃草稿可重新载入当前菜谱。');
      const form = formFields(this.data);
      const next = H.saveRecipe(household, {...form, ...(previous ? {id:previous.id} : {})});
      const recipe = previous ? next.recipes.find(item => item.id === previous.id) :
        next.recipes.find(item => !household.recipes.some(old => old.id === item.id)) ||
        next.recipes.find(item => item.sourceUrl && H.normalizeSourceUrl(item.sourceUrl) === H.normalizeSourceUrl(form.sourceUrl));
      if (!recipe) throw new Error('未找到保存的菜谱，输入仍保留，请重试。');
      if (previous) preserveDetails(previous, recipe, form);
      if (!H.validate(next)) throw new Error('菜谱校验未通过，原记录和当前输入均保留。');
      duplicate = !previous && household.recipes.some(item => item.id === recipe.id);
      if (duplicate) {
        const savedForm = formFor(recipe);
        if (form.name.trim() !== recipe.name || ['ingredientsText', 'stepsText'].some(field => form[field].trim() && form[field] !== savedForm[field])) {
          throw new Error('这个链接已有菜谱「' + recipe.name + '」，本次输入与它不同。输入仍保留，未覆盖已有菜谱；请从菜谱页打开原菜谱编辑。');
        }
      }
      this._pending = {id:recipe.id, value:JSON.stringify(recipe)};
      this.persistDraft();
      store.commit(next);
      this._recipeId = recipe.id;
      this._finished = true;
      this.setData({recipeId:recipe.id, saved:true, saving:false, error:''});
    } catch (error) {
      this._saving = false;
      ui.error(this, error);
      return;
    }
    let message = duplicate ? '该链接已在菜谱中' : '菜谱已保存';
    try { store.clearDraft(this._draftKey); }
    catch (_) { message = '菜谱已保存，旧草稿清理失败'; }
    ui.toast(message);
    ui.back('/pages/library/index');
  }
});
