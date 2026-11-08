'use strict';
const {store} = require('../../core/store');
const {stepImage} = require('../../core/content');
const ui = require('../../core/ui');

Page({
  data: {recipe:null, items:[], steps:[], hasImages:false, error:'', saving:false},
  onLoad(options) { this._id = options.id || ''; },
  onShow() {
    try {
      const recipe = store.get().recipes.find(item => item.id === this._id);
      if (!recipe) { this.setData({recipe:null, items:[], steps:[], hasImages:false, error:'这道菜谱已不存在，请返回菜谱页查看。'}); return; }
      const labels = {include:'保留', omit:'不放', pending:'待确认'};
      const items = recipe.items.map(item => ({...item, choiceLabel:labels[item.choice]}));
      const steps = recipe.steps.map((step, index) => ({...step, number:index + 1, image:stepImage(recipe, index)}));
      this.setData({recipe, items, steps, hasImages:steps.some(step => !!step.image), error:''});
    } catch (error) { ui.error(this, error); }
  },
  editRecipe() {
    if (this.data.recipe) wx.navigateTo({url:'/pages/recipe-edit/index?id=' + encodeURIComponent(this.data.recipe.id)});
  },
  copySource() {
    if (!this.data.recipe?.sourceUrl || this._copying) return;
    this._copying = true;
    this.setData({error:''});
    wx.setClipboardData({
      data:this.data.recipe.sourceUrl,
      success:() => ui.toast('已复制，请到浏览器打开'),
      fail:() => ui.error(this, new Error('链接复制失败，请重试。')),
      complete:() => { this._copying = false; }
    });
  }
});
