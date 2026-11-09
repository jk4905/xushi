'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const script = path.join(root, 'scripts/sync-h5.cjs');
const code = fs.readFileSync(script, 'utf8');
const models = ['core/meal.js', 'core/household.js', 'core/content.js', 'core/seed.js'];
const original = new Map([
  '../h5/weekend-menu-prototype.html', '../h5/weekend-household-model.js', '../h5/weekend-household-seed.js', ...models
].map(file => {
  const target = path.resolve(root, file);
  return [target, fs.readFileSync(target, 'utf8')];
}));

function run(files, args, writes = []) {
  const errors = [];
  const process = {argv:['node', script, ...args], exitCode:0};
  const mockFs = {
    readFileSync(file) {
      if (!files.has(file)) throw Object.assign(new Error('Missing: ' + file), {code:'ENOENT'});
      return files.get(file);
    },
    writeFileSync(file, content) {
      writes.push(file);
      files.set(file, content);
    }
  };
  vm.runInNewContext(code, {
    __dirname:path.dirname(script), process,
    console:{error:message => errors.push(message)},
    require(name) {
      if (name === 'node:fs') return mockFs;
      if (name === 'node:path') return path;
      if (name === 'node:vm') return vm;
      throw new Error('Unexpected dependency: ' + name);
    }
  }, {filename:script});
  return {exitCode:process.exitCode, errors, writes};
}

test('sync --check accepts the current H5 models without writing', () => {
  const files = new Map(original);
  assert.deepEqual(run(files, ['--check']), {exitCode:0, errors:[], writes:[]});
  assert.deepEqual(files, original);
});

for (const model of models) {
  test('sync detects ' + model + ' drift without writing and generation restores it', () => {
    const files = new Map(original);
    const target = path.join(root, model);
    files.set(target, files.get(target) + '\n// drift\n');
    const before = new Map(files);
    assert.deepEqual(run(files, ['--check']), {
      exitCode:1, errors:['Out of sync: ' + model], writes:[]
    });
    assert.deepEqual(files, before);
    assert.deepEqual(run(files, []), {
      exitCode:0, errors:[], writes:models.map(file => path.join(root, file))
    });
    assert.deepEqual(files, original);
    assert.deepEqual(run(files, ['--check']), {exitCode:0, errors:[], writes:[]});
    assert.deepEqual(files, original);
  });
}

test('sync follows H5 dish names and kinds without writing to the H5 inputs', () => {
  const files = new Map(original);
  const htmlFile = path.resolve(root, '../h5/weekend-menu-prototype.html');
  const contentFile = path.join(root, 'core/content.js');
  files.set(htmlFile, files.get(htmlFile).replace(/const dishes=[^\n]+/, line =>
    line.replace("name:'勃艮第炖牛肉',kind:'主菜'", "name:'红酒炖牛肉',kind:'汤菜'")));
  assert.notEqual(files.get(htmlFile), original.get(htmlFile));
  const before = new Map(files);
  assert.deepEqual(run(files, ['--check']), {
    exitCode:1, errors:['Out of sync: core/content.js'], writes:[]
  });
  assert.deepEqual(files, before);
  assert.deepEqual(run(files, []), {
    exitCode:0, errors:[], writes:models.map(file => path.join(root, file))
  });
  const module = {exports:{}};
  vm.runInNewContext(files.get(contentFile), {module});
  const dish = module.exports.seedRecipes[0];
  assert.equal(dish.id, 'beef');
  assert.equal(dish.name, '红酒炖牛肉');
  assert.equal(dish.kind, '汤菜');
  assert.deepEqual(run(files, ['--check']), {exitCode:0, errors:[], writes:[]});
  for (const [file, content] of before) {
    if (file !== contentFile) assert.equal(files.get(file), content);
  }
});

test('sync --check lists every missing model without creating files', () => {
  const files = new Map(original);
  for (const model of models) files.delete(path.join(root, model));
  const before = new Map(files);
  assert.deepEqual(run(files, ['--check']), {
    exitCode:1, errors:models.map(file => 'Out of sync: ' + file), writes:[]
  });
  assert.deepEqual(files, before);
});

for (const args of [['--check', '--images'], ['--images', '--check']]) {
  test('sync rejects ' + args.join(' ') + ' before writing or loading image tools', () => {
    const files = new Map(original), writes = [];
    assert.throws(() => run(files, args, writes), /--check cannot be used with --images/);
    assert.deepEqual(writes, []);
    assert.deepEqual(files, original);
  });
}
