const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createStore,H,M,KEY,META_KEY}=require('../core/store');
function memory() {
 const data=new Map();let failWrite=false, failRead=false;
 return {data,get failWrite(){return failWrite;},set failWrite(v){failWrite=v;},get failRead(){return failRead;},set failRead(v){failRead=v;},getStorageSync(key){if(failRead)throw new Error('read');return data.get(key)||'';},setStorageSync(key,value){if(failWrite)throw new Error('quota');data.set(key,value);}};
}
// Existing feature scenarios start with an explicitly saved empty household.
function setup(){const api=memory();api.data.set(KEY,JSON.stringify({schemaVersion:2,activeMealId:null,recipes:[],meals:[],menus:[],guests:[]}));const store=createStore(api);return {api,store,H,M,KEY,META_KEY};}
function page(name,store,extras={}) {
 let definition;const calls=[];
 const wx={navigateTo:o=>calls.push(['navigateTo',o]),redirectTo:o=>calls.push(['redirectTo',o]),navigateBack:o=>calls.push(['navigateBack',o]),switchTab:o=>calls.push(['switchTab',o]),showToast:o=>calls.push(['toast',o]),showModal:o=>{calls.push(['modal',o]);o.success({confirm:extras.confirm!==false,content:extras.content||''});},...extras.wx};
 const ui={error:(p,e)=>p.setData({error:e.message,saving:false}),toast:title=>wx.showToast({title}),back:url=>calls.push(['back',url]),mealUrl:(page,id)=>'/pages/'+page+'/index?id='+id,confirm:async()=>extras.confirm!==false};
 const filename=path.resolve(__dirname,'../pages/'+name+'/index.js');
 const context=vm.createContext({Page:value=>definition=value,require:request=>{
  if(request==='../../core/store')return {store,H,M};if(request==='../../core/ui')return ui;
  return require(path.resolve(path.dirname(filename),request));
 },wx,setTimeout:fn=>{return 1;},clearTimeout:()=>{},getCurrentPages:()=>[],console});
 vm.runInContext(fs.readFileSync(filename,'utf8'),context,{filename});
 const instance={...definition,data:JSON.parse(JSON.stringify(definition.data||{})),getTabBar:()=>({setData:()=>{}}),setData(patch,cb){for(const [key,value]of Object.entries(patch)){
   const parts=key.replace(/\[(\d+)\]/g,'.$1').split('.');let target=this.data;
   for(const p of parts.slice(0,-1)){if(!target[p])target[p]={};target=target[p];}target[parts.at(-1)]=value;
 }if(cb)cb();}};
 return {instance,calls,wx};
}
module.exports={memory,setup,page};
