const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ejs = require('ejs');

// A syntax error inside an EJS <script> block or in public JS only shows up in the browser, where
// nothing in this suite would see it. These checks compile every template and every piece of
// browser JavaScript the prototype ships, so a broken block fails the suite instead of the demo.

const root = path.join(__dirname, '..');
const viewsDir = path.join(root, 'views');

function templateFiles() {
  const files = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ejs')) files.push(full);
    }
  }
  walk(viewsDir);
  return files.sort();
}

function publicJsFiles() {
  const files = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) files.push(full);
    }
  }
  walk(path.join(root, 'public'));
  return files.sort();
}

// Inline <script> blocks, excluding external ones (<script src=...>).
function inlineScripts(source) {
  const blocks = [];
  const pattern = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    if (match[1].trim().length > 0) blocks.push(match[1]);
  }
  return blocks;
}

test('every EJS template compiles', function() {
  const files = templateFiles();
  assert.ok(files.length > 0, 'no templates found');
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    assert.doesNotThrow(function() {
      ejs.compile(source, { filename: file });
    }, 'template does not compile: ' + path.relative(root, file));
  }
});

test('every inline <script> block in a template is syntactically valid JavaScript', function() {
  let checked = 0;
  for (const file of templateFiles()) {
    const source = fs.readFileSync(file, 'utf8');
    const blocks = inlineScripts(source);
    for (let i = 0; i < blocks.length; i++) {
      // An EJS tag inside a script block becomes a value at render time. Substitute a literal so
      // the surrounding JavaScript can still be parsed on its own.
      const js = blocks[i]
        .replace(/<%[-=]?([\s\S]*?)%>/g, '0');
      assert.doesNotThrow(function() {
        new vm.Script(js, { filename: path.relative(root, file) + ' <script#' + (i + 1) + '>' });
      }, 'invalid JavaScript in ' + path.relative(root, file) + ' script block ' + (i + 1));
      checked += 1;
    }
  }
  // Guard against this check silently passing because the extraction stopped finding anything.
  assert.ok(checked >= 1, 'expected at least one inline script block to check, found ' + checked);
});

test('every public JavaScript file is syntactically valid', function() {
  const files = publicJsFiles();
  assert.ok(files.length > 0, 'no public JavaScript found');
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    assert.doesNotThrow(function() {
      new vm.Script(source, { filename: path.relative(root, file) });
    }, 'invalid JavaScript in ' + path.relative(root, file));
  }
});

test('no template ships a browser timer that invents demo activity', function() {
  for (const file of templateFiles()) {
    const source = fs.readFileSync(file, 'utf8');
    for (const block of inlineScripts(source)) {
      assert.ok(!/setInterval/.test(block),
        path.relative(root, file) + ' must not run a timer that adds activity');
      assert.ok(!/\.innerHTML\s*=/.test(block),
        path.relative(root, file) + ' must not build markup from strings');
    }
  }
});
