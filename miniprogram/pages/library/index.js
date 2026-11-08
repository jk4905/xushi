'use strict';
const {store, H} = require('../../core/store');
const ui = require('../../core/ui');

Page({
  data: {section:'recipes', query:'', recipes:[], menus:[], recipeCount:0, menuCount:0, error:'', saving:false},
  onShow() {
    this.getTabBar?.()?.setData({active:'library'});
    this.refresh();
  },
  refresh() {
    try {
      const household = store.get(), query = this.data.query.trim().toLocaleLowerCase();
      const recipes = household.recipes.filter(recipe => [recipe.name, ...recipe.items.map(item => item.name)]
        .some(value => value.toLocaleLowerCase().includes(query))).map(recipe => ({
          id:recipe.id, name:recipe.name, kind:recipe.kind,
          detail:recipe.items.length ? recipe.items.map(item => item.name).join('、') : '材料未记录'
        }));
      const menus = household.menus.map(menu => ({
        id:menu.id, title:menu.title, count:menu.recipeIds.length,
        dishes:menu.recipeIds.map(id => household.recipes.find(recipe => recipe.id === id)?.name || '').join('、')
      })).filter(menu => [menu.title, menu.dishes].some(value => value.toLocaleLowerCase().includes(query)));
      this.setData({recipes, menus, recipeCount:household.recipes.length, menuCount:household.menus.length});
    } catch (error) { ui.error(this, error); }
  },
  onSearch(event) {
    this.setData({query:event.detail.value});
    this.refresh();
  },
  setSection(event) {
    const section = event.currentTarget.dataset.section;
    if (!['recipes', 'menus'].includes(section)) return;
    this.setData({section, query:''});
    this.refresh();
  },
  openRecipe(event) {
    wx.navigateTo({url:'/pages/recipe/index?id=' + encodeURIComponent(event.currentTarget.dataset.id)});
  },
  addRecipe() { wx.navigateTo({url:'/pages/recipe-edit/index'}); },
  openMenu(event) {
    const id = event.currentTarget.dataset.id;
    wx.navigateTo({url:'/pages/builder/index?mode=menu' + (id ? '&menuId=' + encodeURIComponent(id) : '')});
  },
  openBackup() { wx.navigateTo({url:'/pages/backup/index'}); },
  addExamples() {
    if (this._saving) return;
    this._saving = true;
    this.setData({saving:true, error:''});
    try {
      store.addExamples();
      this.setData({query:''});
      this.refresh();
      ui.toast('已添加原始三道菜谱');
    } catch (error) { ui.error(this, error); }
    finally { this._saving = false; this.setData({saving:false}); }
  },
  async deleteMenu(event) {
    if (this._saving) return;
    this._saving = true;
    this.setData({saving:true, error:''});
    try {
      const id = event.currentTarget.dataset.id;
      const menu = store.get().menus.find(item => item.id === id);
      if (!menu) throw new Error('这份菜单已不存在，请刷新后重试。');
      if (!await ui.confirm({title:'删除常做菜单', content:'删除「' + menu.title + '」？菜谱和已安排的餐会保留。', confirmText:'删除菜单'})) return;
      store.commit(H.removeMenu(store.get(), id));
      this.refresh();
      ui.toast('菜单已删除');
    } catch (error) { ui.error(this, error); }
    finally { this._saving = false; this.setData({saving:false}); }
  }
});
