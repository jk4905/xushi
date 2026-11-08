'use strict';
const {store, H} = require('../../core/store');
const ui = require('../../core/ui');
const statuses = ['planned', 'completed', 'cancelled'];

Page({
  data: {status: 'planned', meals: [], counts: {planned: 0, completed: 0, cancelled: 0}, saving: false, error: ''},

  onLoad(options = {}) {
    if (statuses.includes(options.status)) this.setData({status: options.status});
    this._menuTitles = {};
  },

  onShow() {
    this._leaving = false;
    this._repeated = null;
    this.refresh();
  },

  refresh() {
    try {
      const household = store.get(), counts = {planned: 0, completed: 0, cancelled: 0};
      household.meals.forEach(meal => { counts[meal.status] += 1; });
      this.setData({counts, meals: household.meals.filter(meal => meal.status === this.data.status).reverse().map(meal => ({
        id: meal.id, title: meal.title, date: meal.date, status: meal.status,
        names: meal.recipeIds.map(id => household.recipes.find(recipe => recipe.id === id)?.name).filter(Boolean).join(' · ')
      }))});
    } catch (error) { ui.error(this, error); }
  },

  changeStatus(event) {
    const status = event.currentTarget.dataset.status;
    if (this._saving || !statuses.includes(status)) return;
    this.setData({status, error: ''});
    this.refresh();
  },

  async perform(action) {
    if (this._saving || this._leaving) return;
    this._saving = true;
    this.setData({saving: true, error: ''});
    try { await action(); }
    catch (error) { ui.error(this, error); }
    finally { this._saving = false; this.setData({saving: false}); }
  },

  meal(id) {
    const meal = store.meal(id);
    if (!meal) throw new Error('没有找到这餐，请返回刷新后重试。');
    return meal;
  },

  openMeal(page, id) {
    this._leaving = true;
    wx.navigateTo({url: ui.mealUrl(page, id), fail: () => {
      this._leaving = false;
      ui.error(this, new Error('记录已保留，页面未能打开，请重试。'));
    }});
  },

  continueMeal(event) {
    return this.perform(() => {
      const {id, page} = event.currentTarget.dataset;
      if (!['shopping', 'cook'].includes(page)) throw new Error('无法打开这个页面。');
      this.meal(id);
      store.change(household => H.selectMeal(household, id));
      this.openMeal(page, id);
    });
  },

  cancelMeal(event) {
    return this.perform(async () => {
      const id = event.currentTarget.dataset.id, meal = this.meal(id);
      if (meal.status !== 'planned') throw new Error('只能取消待做的餐。');
      if (!await ui.confirm({title: '取消这餐？', content: `“${meal.title}”会移到已取消，之后可以恢复。`, confirmText: '取消这餐'})) return;
      store.change(household => H.setMealStatus(household, id, 'cancelled'));
      this.refresh();
      ui.toast('已取消，可以随时恢复');
    });
  },

  restoreMeal(event) {
    return this.perform(() => {
      const id = event.currentTarget.dataset.id;
      this.meal(id);
      store.change(household => H.setMealStatus(household, id, 'planned'));
      this.setData({status: 'planned'});
      this.refresh();
      ui.toast('已恢复到待做');
    });
  },

  repeatMeal(event) {
    return this.perform(() => {
      const id = event.currentTarget.dataset.id;
      if (!this._repeated || this._repeated.source !== id) {
        const household = store.get(), original = this.meal(id);
        let number = 1;
        while (household.meals.some(meal => meal.id === `meal-${number}`)) number += 1;
        const mealId = `meal-${number}`;
        // 复制本餐快照，避免已改动的菜谱覆盖这餐的用量、取舍和备注。
        household.meals.push({...original, id: mealId, date: '', status: 'planned', data: {
          ...original.data, items: original.data.items.map(item => ({...item, status: 'unchecked'})), versions: []
        }});
        household.activeMealId = mealId;
        store.commit(household);
        this._repeated = {source: id, mealId};
      }
      this.openMeal('shopping', this._repeated.mealId);
    });
  },

  saveAsMenu(event) {
    return this.perform(async () => {
      const id = event.currentTarget.dataset.id, meal = this.meal(id);
      const result = await new Promise((resolve, reject) => wx.showModal({
        title: '存为常做菜单', editable: true, placeholderText: '给菜单起个名字',
        content: this._menuTitles[id] === undefined ? meal.title : this._menuTitles[id],
        confirmText: '保存', confirmColor: '#173D2B',
        success: resolve, fail: () => reject(new Error('未能打开菜单名称输入框，请重试。'))
      }));
      if (!result.confirm) return;
      this._menuTitles[id] = typeof result.content === 'string' ? result.content : '';
      store.change(household => H.saveMealAsMenu(household, this._menuTitles[id].trim(), id));
      ui.toast('已存为常做菜单');
    });
  },

  editMeal(event) {
    if (this._saving || this._leaving) return;
    wx.navigateTo({url: ui.mealUrl('builder', event.currentTarget.dataset.id) + '&from=history',
      fail: () => ui.error(this, new Error('未能打开编辑页，请重试。'))});
  },

  newMeal() {
    if (this._saving || this._leaving) return;
    wx.navigateTo({url: '/pages/builder/index?from=history', fail: () => ui.error(this, new Error('未能打开选菜页，请重试。'))});
  }
});
