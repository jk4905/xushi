'use strict';
const {store, H} = require('../../core/store');
const ui = require('../../core/ui');

const sameRecipes = (first, second) => first.length === second.length && first.every(id => second.includes(id));

Page({
  data: {
    mode: 'meal', id: '', title: '', date: '', query: '', section: 'recipes',
    recipeIds: [], selectedMenuId: '', recipes: [], menus: [], selectedNames: '',
    recipeCount: 0, menuCount: 0, error: '', saving: false, committed: false,
    keyboardOpen: false, inputFocused: false
  },

  onLoad(options = {}) {
    const mode = options.mode === 'menu' ? 'menu' : 'meal';
    const id = mode === 'menu' ? options.menuId || options.id || '' : options.id || '';
    this._draftKey = `builder:${mode}:${id || 'new'}`;
    this._fallback = options.from === 'history' ? '/pages/history/index' :
      mode === 'menu' || options.from === 'library' ? '/pages/library/index' : '/pages/home/index';
    this.setData({mode, id});
    try {
      const household = store.get();
      const existing = (mode === 'menu' ? household.menus : household.meals).find(entry => entry.id === id);
      if (id && !existing) throw new Error(mode === 'menu' ? '没有找到这份菜单，请返回重试。' : '没有找到这餐，请返回重试。');
      const savedDraft = store.draft(this._draftKey);
      const draft = savedDraft || existing || {};
      const menu = mode === 'meal' && !id && !savedDraft &&
        household.menus.find(entry => entry.id === options.menuId);
      const recipeIds = Array.isArray(draft.recipeIds) ? draft.recipeIds : menu ? menu.recipeIds : [];
      this.setData({
        title: typeof draft.title === 'string' ? draft.title : '',
        date: mode === 'meal' && typeof draft.date === 'string' ? draft.date : '',
        query: typeof draft.query === 'string' ? draft.query : '',
        section: mode === 'meal' && draft.section === 'menus' ? 'menus' : 'recipes',
        recipeIds: [...new Set(recipeIds.filter(value => household.recipes.some(recipe => recipe.id === value)))],
        selectedMenuId: typeof draft.selectedMenuId === 'string' ? draft.selectedMenuId : menu ? menu.id : ''
      });
      this._pending = draft.pending || null;
      this.recoverCommit(household);
      this._loaded = true;
      this.refresh();
    } catch (error) { ui.error(this, error); }
  },

  onShow() {
    if (this._loaded) this.refresh();
  },

  onHide() {
    this.setData({inputFocused: false, keyboardOpen: false});
    if (this._loaded && !this._committed) this.remember();
  },

  refresh() {
    try {
      const household = store.get(), query = this.data.query.trim().toLocaleLowerCase();
      const names = ids => ids.map(id => household.recipes.find(recipe => recipe.id === id)?.name).filter(Boolean).join(' · ');
      const recipes = household.recipes.map(recipe => ({
        id: recipe.id, name: recipe.name,
        ingredients: recipe.items.map(item => item.name).join('、') || '材料尚未记录',
        checked: this.data.recipeIds.includes(recipe.id)
      }));
      this.setData({
        recipes: recipes.filter(recipe => `${recipe.name} ${recipe.ingredients}`.toLocaleLowerCase().includes(query)),
        menus: household.menus.map(menu => ({
          id: menu.id, title: menu.title, names: names(menu.recipeIds),
          checked: this.data.selectedMenuId === menu.id && sameRecipes(menu.recipeIds, this.data.recipeIds)
        })).filter(menu => `${menu.title} ${menu.names}`.toLocaleLowerCase().includes(query)),
        recipeCount: household.recipes.length, menuCount: household.menus.length,
        selectedNames: names(this.data.recipeIds)
      });
    } catch (error) { ui.error(this, error); }
  },

  draftValue() {
    const {title, date, query, section, recipeIds, selectedMenuId} = this.data;
    return {title, date, query, section, recipeIds, selectedMenuId, pending: this._pending || null};
  },

  remember() {
    try { store.saveDraft(this._draftKey, this.draftValue()); }
    catch (error) { ui.error(this, error); }
  },

  change(patch) {
    if (!this._loaded || this._saving || this._committed) return;
    this._pending = null;
    this.setData({...patch, error: ''});
    this.remember();
    this.refresh();
  },

  onInput(event) {
    const field = event.currentTarget.dataset.field;
    if (['title', 'query'].includes(field)) this.change({[field]: event.detail.value});
  },

  onDateChange(event) { this.change({date: event.detail.value}); },
  clearDate() { this.change({date: ''}); },
  onFocus() { this.setData({inputFocused: true}); },
  onBlur() { this.setData({inputFocused: false}); },
  onKeyboardHeightChange(event) { this.setData({keyboardOpen: event.detail.height > 0}); },

  switchSection(event) {
    const section = event.currentTarget.dataset.section;
    if (['recipes', 'menus'].includes(section)) this.change({section});
  },

  onRecipesChange(event) {
    const visible = this.data.recipes.map(recipe => recipe.id);
    const hidden = this.data.recipeIds.filter(id => !visible.includes(id));
    this.change({recipeIds: [...new Set([...hidden, ...event.detail.value.filter(id => visible.includes(id))])]});
  },

  chooseMenu(event) {
    try {
      const menu = store.get().menus.find(entry => entry.id === event.currentTarget.dataset.id);
      if (!menu) throw new Error('这份菜单已不存在，请重新选择。');
      this.change({recipeIds: menu.recipeIds, selectedMenuId: menu.id});
    } catch (error) { ui.error(this, error); }
  },

  addRecipe() {
    if (!this._loaded || this._saving || this._committed) return;
    this.remember();
    wx.navigateTo({url: '/pages/recipe-edit/index?from=builder', fail: () => ui.error(this, new Error('未能打开菜谱编辑页，请重试。'))});
  },

  recoverCommit(household) {
    if (this.data.id || !this._pending) return;
    const entries = this.data.mode === 'menu' ? household.menus : household.meals;
    const saved = entries.find(entry => entry.id === this._pending.id);
    if (!saved) return;
    // shortcut: 创建字段改动或同字段 ID 复用无法可靠区分；需覆盖时由模型保存不可变提交标识。
    const matches = this.data.mode === 'meal' ?
      ['title', 'date'].every(key => saved[key] === this._pending[key]) &&
      ['recipeIds', 'guestIds'].every(key => Array.isArray(this._pending[key]) && sameRecipes(saved[key], this._pending[key])) :
      JSON.stringify(saved) === JSON.stringify(this._pending);
    if (!matches) {
      this._pending = null;
      return;
    }
    this._committed = saved.id;
    this.setData({committed: true});
  },

  save() {
    if (!this._loaded || this._saving || this._leaving) return;
    this._saving = true;
    this.setData({saving: true, error: ''});
    try {
      if (!this._committed) {
        const household = store.get();
        this.recoverCommit(household);
        if (!this._committed) {
          const {mode, id, date, recipeIds, selectedMenuId} = this.data;
          const title = this.data.title.trim() || (mode === 'meal' ? date ? '这餐' : '今晚这餐' : '');
          let next, result;
          if (mode === 'menu') {
            next = H.saveMenu(household, {title, recipeIds, ...(id ? {id} : {})});
            result = next.menus.find(menu => id ? menu.id === id : !household.menus.some(old => old.id === menu.id));
          } else if (id) {
            next = H.updateMeal(household, id, {title, date, recipeIds});
            result = next.meals.find(meal => meal.id === id);
          } else {
            const menu = household.menus.find(entry => entry.id === selectedMenuId);
            next = menu && sameRecipes(menu.recipeIds, recipeIds) ?
              H.useMenu(household, menu.id) : H.createMeal(household, {title, date, recipeIds});
            next = H.updateMeal(next, next.activeMealId, {title, date});
            result = next.meals.find(meal => meal.id === next.activeMealId);
          }
          // 先记录将创建的对象，清草稿失败后重进页面也不会再次新增。
          if (!id) {
            this._pending = result;
            store.saveDraft(this._draftKey, this.draftValue());
          }
          store.commit(next);
          this._committed = result.id;
          this.setData({committed: true});
        }
      }
      try { store.clearDraft(this._draftKey); }
      catch (error) {
        ui.error(this, error);
        ui.toast('已保存，草稿清理失败');
      }
      this._leaving = true;
      if (this.data.mode === 'meal' && !this.data.id) {
        wx.redirectTo({url: ui.mealUrl('shopping', this._committed), fail: () => {
          this._leaving = false;
          ui.error(this, new Error('这餐已保存，未能打开购物页。请点“继续准备”重试。'));
        }});
      } else ui.back(this._fallback);
    } catch (error) { ui.error(this, error); }
    finally { this._saving = false; this.setData({saving: false}); }
  }
});
