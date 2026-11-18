'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { makeExampleOrder } = require('../../../test/fixtures/siparis/example-order');
const { renderProductionForm, renderApprovalForm, renderPrintForm, renderEmbroideryForm } = require('./index');

async function main() {
  const target = path.resolve(__dirname, '../../../test/tmp');
  await fs.mkdir(target, { recursive: true });
  const order = makeExampleOrder();
  for (const [name, render] of Object.entries({ uretim: renderProductionForm, onay: renderApprovalForm, baski: renderPrintForm, nakis: renderEmbroideryForm })) {
    const buffer = await render(order);
    if (buffer) {
      const filename = path.join(target, `${name}.pdf`);
      await fs.writeFile(filename, buffer);
      console.log(filename);
    }
  }
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });

module.exports = { main };
