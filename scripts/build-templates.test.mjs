import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { buildTemplates, getTemplateInputSignature } from './build-templates.mjs';

let workDir;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'build-templates-test-'));
  mkdirSync(join(workDir, 'src', 'ui'), { recursive: true });
});

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

function paths(validateConsumers = false) {
  return {
    uiDir: join(workDir, 'src', 'ui'),
    indexHtmlPath: join(workDir, 'index.html'),
    outputPath: join(workDir, 'public', 'index.html'),
    validateConsumers,
  };
}

function writeIndexHtml(marker = '<!-- templates -->') {
  writeFileSync(
    join(workDir, 'index.html'),
    `<!DOCTYPE html><html><head></head><body>\n  ${marker}\n  <script type="module" src="dist/main.js"></script>\n</body></html>\n`,
  );
}

describe('buildTemplates', () => {
  test('stitches templates from multiple files in deterministic sorted order', () => {
    writeIndexHtml();
    mkdirSync(join(workDir, 'src', 'ui', 'debug'), { recursive: true });
    writeFileSync(join(workDir, 'src', 'ui', 'zebra.template.html'), '<template id="tpl-zebra"><p>z</p></template>');
    writeFileSync(join(workDir, 'src', 'ui', 'alpha.template.html'), '<template id="tpl-alpha"><p>a</p></template>');
    writeFileSync(
      join(workDir, 'src', 'ui', 'debug', 'nested.template.html'),
      '<template id="tpl-nested"><p>n</p></template>',
    );

    const result = buildTemplates(paths());

    assert.deepEqual(result.ids.sort(), ['tpl-alpha', 'tpl-nested', 'tpl-zebra']);
    const output = readFileSync(paths().outputPath, 'utf8');
    const alphaIndex = output.indexOf('tpl-alpha');
    const nestedIndex = output.indexOf('tpl-nested');
    const zebraIndex = output.indexOf('tpl-zebra');
    assert.ok(alphaIndex < nestedIndex, 'alpha.template.html should stitch before debug/nested.template.html');
    assert.ok(nestedIndex < zebraIndex, 'debug/nested.template.html should stitch before zebra.template.html');
    assert.ok(!output.includes('<!-- templates -->'), 'marker must not survive into output');
  });

  test('preserves authored HTML whitespace', () => {
    writeIndexHtml();
    const markup = '<template id="tpl-copy"><span>Hello</span>\n<span>world</span></template>';
    writeFileSync(join(workDir, 'src', 'ui', 'copy.template.html'), markup);

    buildTemplates(paths());

    assert.ok(readFileSync(paths().outputPath, 'utf8').includes(markup));
  });

  test('produces byte-identical output across repeated runs (deterministic)', () => {
    writeIndexHtml();
    writeFileSync(join(workDir, 'src', 'ui', 'a.template.html'), '<template id="tpl-a"><p>a</p></template>');
    writeFileSync(join(workDir, 'src', 'ui', 'b.template.html'), '<template id="tpl-b"><p>b</p></template>');

    buildTemplates(paths());
    const first = readFileSync(paths().outputPath, 'utf8');
    buildTemplates(paths());
    const second = readFileSync(paths().outputPath, 'utf8');

    assert.equal(first, second);
  });

  test('rejects zero template files by default', () => {
    writeIndexHtml();

    assert.throws(() => buildTemplates(paths()), /no \.template\.html files found/);
  });

  test('allows zero template files when allowEmpty is set', () => {
    writeIndexHtml();

    const result = buildTemplates({ ...paths(), allowEmpty: true });

    assert.deepEqual(result.ids, []);
    assert.ok(readFileSync(paths().outputPath, 'utf8').length > 0);
  });

  test('rejects a file with no template id', () => {
    writeIndexHtml();
    writeFileSync(join(workDir, 'src', 'ui', 'broken.template.html'), '<div>no template here</div>');

    assert.throws(() => buildTemplates(paths()), /no <template id="\.\.\.">/);
  });

  test('rejects duplicate template ids across files', () => {
    writeIndexHtml();
    mkdirSync(join(workDir, 'src', 'ui', 'one'), { recursive: true });
    mkdirSync(join(workDir, 'src', 'ui', 'two'), { recursive: true });
    writeFileSync(
      join(workDir, 'src', 'ui', 'one', 'dupe.template.html'),
      '<template id="tpl-dupe"><p>a</p></template>',
    );
    writeFileSync(
      join(workDir, 'src', 'ui', 'two', 'dupe.template.html'),
      '<template id="tpl-dupe"><p>b</p></template>',
    );

    assert.throws(() => buildTemplates(paths()), /duplicate template id "tpl-dupe"/);
  });

  test('rejects a template id that does not match its filename', () => {
    writeIndexHtml();
    writeFileSync(
      join(workDir, 'src', 'ui', 'widget.template.html'),
      '<template id="tpl-other"><p></p></template>',
    );

    assert.throws(() => buildTemplates(paths()), /must be "tpl-widget" or start with "tpl-widget-"/);
  });

  test('rejects index.html with no marker', () => {
    writeIndexHtml('<!-- no marker here -->');
    writeFileSync(join(workDir, 'src', 'ui', 'a.template.html'), '<template id="tpl-a"><p>a</p></template>');

    assert.throws(() => buildTemplates(paths()), /expected exactly one/);
  });

  test('rejects index.html with a duplicated marker', () => {
    writeIndexHtml('<!-- templates -->\n<!-- templates -->');
    writeFileSync(join(workDir, 'src', 'ui', 'a.template.html'), '<template id="tpl-a"><p>a</p></template>');

    assert.throws(() => buildTemplates(paths()), /expected exactly one/);
  });

  test('creates the output directory if missing', () => {
    writeIndexHtml();
    writeFileSync(join(workDir, 'src', 'ui', 'a.template.html'), '<template id="tpl-a"><p>a</p></template>');

    buildTemplates(paths());

    assert.ok(readFileSync(paths().outputPath, 'utf8').includes('tpl-a'));
  });

  test('rejects a cloneTemplate consumer whose template id is missing', () => {
    writeIndexHtml();
    writeFileSync(
      join(workDir, 'src', 'ui', 'widget.template.html'),
      '<template id="tpl-widget"><p></p></template>',
    );
    writeFileSync(
      join(workDir, 'src', 'ui', 'widget.ts'),
      "const fragment = cloneTemplate('tpl-missing');\n",
    );

    assert.throws(
      () => buildTemplates(paths(true)),
      /cloneTemplate\(\) references missing template id\(s\): tpl-missing/,
    );
  });

  test('rejects a template with no cloneTemplate consumer', () => {
    writeIndexHtml();
    writeFileSync(
      join(workDir, 'src', 'ui', 'widget.template.html'),
      '<template id="tpl-widget"><p></p></template>',
    );
    writeFileSync(join(workDir, 'src', 'ui', 'widget.ts'), 'export const value = 1;\n');

    assert.throws(
      () => buildTemplates(paths(true)),
      /template id\(s\) have no cloneTemplate\(\) consumer: tpl-widget/,
    );
  });

  test('accepts matching filename, template id, and cloneTemplate consumer', () => {
    writeIndexHtml();
    writeFileSync(
      join(workDir, 'src', 'ui', 'widget.template.html'),
      '<template id="tpl-widget"><p></p></template>',
    );
    writeFileSync(
      join(workDir, 'src', 'ui', 'widget.ts'),
      "const fragment = cloneTemplate('tpl-widget');\n",
    );

    const result = buildTemplates(paths(true));

    assert.deepEqual(result.ids, ['tpl-widget']);
  });

  test('rejects a template consumed only by a different component file', () => {
    writeIndexHtml();
    writeFileSync(
      join(workDir, 'src', 'ui', 'widget.template.html'),
      '<template id="tpl-widget"><p></p></template>',
    );
    writeFileSync(
      join(workDir, 'src', 'ui', 'other.ts'),
      "const fragment = cloneTemplate('tpl-widget');\n",
    );

    assert.throws(
      () => buildTemplates(paths(true)),
      /template id "tpl-widget".*must be consumed by ui\/widget\.ts/,
    );
  });
});

describe('getTemplateInputSignature', () => {
  test('changes only when a template input changes', () => {
    writeIndexHtml();
    const templatePath = join(workDir, 'src', 'ui', 'widget.template.html');
    writeFileSync(templatePath, '<template id="tpl-widget"><p>one</p></template>');

    const signature = getTemplateInputSignature(paths());

    mkdirSync(join(workDir, 'public'), { recursive: true });
    writeFileSync(join(workDir, 'public', 'index.html'), 'generated output changed');
    writeFileSync(join(workDir, 'src', 'ui', 'widget.ts'), 'source changed');
    assert.equal(getTemplateInputSignature(paths()), signature);

    writeFileSync(templatePath, '<template id="tpl-widget"><p>two</p></template>');
    assert.notEqual(getTemplateInputSignature(paths()), signature);
  });

  test('changes when index.html changes', () => {
    writeIndexHtml();
    const initial = getTemplateInputSignature(paths());

    writeIndexHtml('<!-- templates -->\n<!-- another authored change -->');

    assert.notEqual(getTemplateInputSignature(paths()), initial);
  });
});
