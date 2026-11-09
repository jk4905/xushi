'use strict';
const H = require('./household');
const M = require('./meal');
const {seedRecipes} = require('./content');
const initialHousehold = require('./seed');
const KEY = 'xushi-household-v2', META_KEY = 'xushi-reading-drafts-v1';
const LIMIT = 900 * 1024, IMPORT_LIMIT=4*1024*1024;
const clone = value => JSON.parse(JSON.stringify(value));
const empty = () => ({schemaVersion:2,activeMealId:null,recipes:[],meals:[],menus:[],guests:[]});
const byteLength = value => encodeURIComponent(value).replace(/%[A-F\d]{2}/g,'x').length;
function createStore(api) {
  let household = empty(), metadata = {drafts:{},cooking:{}}, epoch='legacy', blocked = '', initialSaveError = '', metaBlocked = '', loaded = false;
  const read = key => { const value = api.getStorageSync(key); return typeof value === 'string' && value ? JSON.parse(value) : value; };
  function load() {
    if (loaded) return;
    loaded = true;
    try { const saved = read(KEY); if(saved !== '' && saved !== undefined) {
      const data=saved.storageVersion===1?saved.household:saved;
      if(!H.validate(data)||(saved.storageVersion===1&&typeof saved.epoch!=='string')) throw new Error('invalid');
      household=data;epoch=saved.storageVersion===1?saved.epoch:'legacy';
    } else {
      if(!H.validate(initialHousehold)) throw new Error('invalid seed');
      household=clone(initialHousehold);epoch='bundled-test-20261109';
      try { write(KEY,{storageVersion:1,epoch,household}); }
      catch (_) { initialSaveError='试用数据暂未保存，请检查设备空间后重新打开，或修改记录重试保存。'; }
    } }
    catch (_) { blocked='本地记录未能读取，原数据已保留。请到备份页导出原始记录，或导入有效备份恢复。'; }
    try {
      const saved=read(META_KEY);
      if(saved && (saved.epoch||'legacy')===epoch) {
        if(!saved || typeof saved!=='object' || !saved.drafts || typeof saved.drafts!=='object' || Array.isArray(saved.drafts) || !saved.cooking || typeof saved.cooking!=='object' || Array.isArray(saved.cooking)) throw new Error('invalid');
        // Drafts are only prefilled inputs. Domain writes still pass the strict v2 validator.
        metadata={drafts:saved.drafts,cooking:{}};
        for(const [id,progress] of Object.entries(saved.cooking)) {
          const meal=household.meals.find(m=>m.id===id);
          if(!meal || !progress || !meal.recipeIds.includes(progress.recipeId)) continue;
          const positions={};
          for(const [rid,top] of Object.entries(progress.positions||{})) if(meal.recipeIds.includes(rid)&&Number.isFinite(top)&&top>=0) positions[rid]=Math.min(top,1000000);
          const expanded={};
          for(const [rid,value]of Object.entries(progress.expanded||{}))if(meal.recipeIds.includes(rid)&&typeof value==='boolean')expanded[rid]=value;
          metadata.cooking[id]={recipeId:progress.recipeId,positions,...(Object.keys(expanded).length?{expanded}: {})};
        }
      }
    } catch (_) { metaBlocked='阅读位置或草稿未能读取，原记录已保留。可在备份页单独重置这些辅助记录。'; }
  }
  function write(key,value) {
    const raw=JSON.stringify(value);
    const payload=key===KEY?JSON.stringify(value.household):raw;
    // Keep the same payload budget across epochs; remaining platform space covers the envelope.
    if(byteLength(payload)>LIMIT) throw new Error('本机单条存储已接近容量上限，请先导出备份；本次输入仍保留。');
    try { api.setStorageSync(key,raw); if(JSON.stringify(read(key))!==raw) throw new Error('readback'); }
    catch (_) { throw new Error('未能确认保存成功，请检查设备空间后重试。当前输入已保留。'); }
  }
  const store = {
    get() {load();return clone(household);},
    meta() {load();return clone(metadata);},
    issue() {load();return blocked||initialSaveError||metaBlocked;},
    meal(id) {load();return clone(household.meals.find(m=>m.id===(id||household.activeMealId))||null);},
    commit(next) {
      load(); if(blocked) throw new Error(blocked);
      if(!H.validate(next)) throw new Error('用餐数据校验未通过，原记录未改动。');
      write(KEY,{storageVersion:1,epoch,household:next}); household=clone(next); initialSaveError=''; return store.get();
    },
    change(fn) {return store.commit(fn(store.get()));},
    draft(key) {load();return clone(metadata.drafts[key]||null);},
    saveDraft(key,value) {
      load(); const next=clone(metadata);next.drafts[key]=clone(value);
      // Keep current-session input even when the device cannot persist it.
      metadata=next; if(metaBlocked) throw new Error(metaBlocked); write(META_KEY,{epoch,...next});
    },
    clearDraft(key) {
      load();const next=clone(metadata);delete next.drafts[key];metadata=next;
      if(metaBlocked) throw new Error(metaBlocked);write(META_KEY,{epoch,...next});
    },
    startCooking(id) {
      const meal=store.meal(id); if(!meal||meal.status!=='planned') throw new Error('这餐已不在待做列表，请先恢复这餐。');
      const previous=metadata.cooking[id];
      const recipeId=previous&&meal.recipeIds.includes(previous.recipeId)?previous.recipeId:meal.recipeIds[0];
      store.setReading(id,recipeId,previous?.positions?.[recipeId]||0);
      return clone(metadata.cooking[id]);
    },
    setReading(id,recipeId,scrollTop,materialsOpen) {
      load();const meal=store.meal(id);
      if(!meal||!meal.recipeIds.includes(recipeId)||!Number.isFinite(scrollTop)||scrollTop<0) throw new Error('阅读位置无效。');
      const next=clone(metadata), previous=next.cooking[id]||{positions:{}};
      const expanded={...(previous.expanded||{})};if(typeof materialsOpen==='boolean')expanded[recipeId]=materialsOpen;
      next.cooking[id]={recipeId,positions:{...previous.positions,[recipeId]:Math.min(scrollTop,1000000)},...(Object.keys(expanded).length?{expanded}: {})};
      metadata=next;if(metaBlocked) throw new Error(metaBlocked);write(META_KEY,{epoch,...next});
    },
    exportText() {load();if(blocked) throw new Error(blocked);return JSON.stringify(household);},
    rawText() {const value=api.getStorageSync(KEY);if(!value)return '';
      try{const parsed=typeof value==='string'?JSON.parse(value):value;if(parsed.storageVersion===1&&H.validate(parsed.household))return JSON.stringify(parsed.household);}catch(_){}
      return typeof value==='string'?value:JSON.stringify(value);},
    importText(text) {
      load();if(typeof text!=='string'||byteLength(text)>IMPORT_LIMIT) throw new Error('备份文件过大，最多4 MB；有效数据最多900 KB。');
      let parsed;try{parsed=JSON.parse(text);}catch(_){throw new Error('文件不是有效的 JSON 备份。');}
      if(!H.validate(parsed)) {
        if(!M.validate(parsed)) throw new Error('备份格式无效，未替换原记录。');
        parsed=H.migrate(parsed,seedRecipes);
      }
      // Preserve a recoverable copy before replacement, including unreadable primary data.
      const original=api.getStorageSync(KEY);
      let sameCandidate=false;
      try{const saved=typeof original==='string'?JSON.parse(original):original;sameCandidate=JSON.stringify(saved?.storageVersion===1?saved.household:saved)===JSON.stringify(parsed);}catch(_){}
      // A write may succeed before readback fails; retry must retain the original pre-import copy.
      const existingSnapshot=api.getStorageSync(KEY+'-before-import');
      if(original&&(!sameCandidate||!existingSnapshot)) {try{api.setStorageSync(KEY+'-before-import',original);}catch(_){throw new Error('未能备份现有记录，已停止导入。');}}
      const importedEpoch=Date.now().toString(36)+'-'+Math.random().toString(36).slice(2);
      write(KEY,{storageVersion:1,epoch:importedEpoch,household:parsed});household=clone(parsed);epoch=importedEpoch;blocked='';initialSaveError='';
      // Imported recipe/meal ids may overlap; never reuse unrelated reading positions or drafts.
      metadata={drafts:{},cooking:{}};
      try {write(META_KEY,{epoch,...metadata});metaBlocked='';}catch(_){metaBlocked='餐次已导入，辅助记录重置失败。请在备份页重试重置。';}
      return store.get();
    },
    resetMeta() {load();const next={drafts:{},cooking:{}};write(META_KEY,{epoch,...next});metadata=next;metaBlocked='';},
    addExamples() {
      const examples=H.migrate(M.createState(),seedRecipes).recipes;
      examples.find(r=>r.id==='beef').sourceUrl='https://b23.tv/f09s6Nz';
      const next=store.get();
      for(const recipe of examples) {
        if(next.recipes.some(r=>r.id===recipe.id||r.name===recipe.name||(recipe.sourceUrl&&r.sourceUrl===recipe.sourceUrl))) continue;
        next.recipes.push(recipe);
      }
      return store.commit(next);
    }
  };
  return store;
}
// Lazy access lets Node run the same core without a simulated global wx at require time.
const store=createStore({getStorageSync:key=>wx.getStorageSync(key),setStorageSync:(key,value)=>wx.setStorageSync(key,value)});
module.exports={store,createStore,H,M,KEY,META_KEY,LIMIT,IMPORT_LIMIT};
