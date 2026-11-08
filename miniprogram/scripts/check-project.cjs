'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),app=JSON.parse(fs.readFileSync(path.join(root,'app.json')));
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
let pageCount=0;
const primitives=new Set('view scroll-view swiper swiper-item movable-area movable-view cover-view cover-image icon text rich-text progress button checkbox checkbox-group editor form input label picker picker-view picker-view-column radio radio-group slider switch textarea navigator audio camera image live-player live-pusher video map canvas web-view ad official-account open-data block template import include wxs slot'.split(' '));
for(const page of app.pages){
 for(const ext of ['.js','.json','.wxml','.wxss'])assert.ok(fs.existsSync(path.join(root,page+ext)),page+ext+' missing');
 const config=JSON.parse(read(page+'.json')),components={...app.usingComponents,...config.usingComponents};
 let definition;vm.runInNewContext(read(page+'.js'),{Page:d=>definition=d,require:()=>({}),Component:()=>{}},{filename:page+'.js'});
 const wxml=read(page+'.wxml');
 for(const match of wxml.matchAll(/wx:(?:if|elif|for)="([^"]*)"/g))assert.ok(match[1].startsWith('{{')&&match[1].endsWith('}}'),page+': unbound WXML directive '+match[0]);
 for(const match of wxml.matchAll(/<(\w[\w-]*)(?=[\s/>])/g))assert.ok(primitives.has(match[1])||components[match[1]],page+': unknown WXML tag '+match[1]);
 for(const match of wxml.matchAll(/(?:bind|catch):?[\w-]+="([\w]+)"/g))assert.equal(typeof definition[match[1]],'function',page+': missing handler '+match[1]);
 for(const match of wxml.matchAll(/src="(\/assets\/[^"{}]+)"/g))assert.ok(fs.existsSync(path.join(root,match[1].slice(1))),match[1]+' missing');
 pageCount++;
}
for(const tab of app.tabBar.list){assert.ok(app.pages.includes(tab.pagePath));assert.ok(fs.existsSync(path.join(root,tab.iconPath)));}
for(const file of fs.readdirSync(path.join(root,'core')))if(file.endsWith('.js'))new vm.Script(read('core/'+file),{filename:file});
const project=JSON.parse(read('project.config.json'));assert.equal(project.appid,'wx65ed03f757d45065');
assert.equal(app.tabBar.list.length,2);
console.log('PASS project structure: '+pageCount+' pages, all declared handlers/assets/routes and JS parse checks.');
console.log('This is not a WeChat compiler or device rendering check.');
