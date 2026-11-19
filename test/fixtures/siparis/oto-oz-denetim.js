'use strict';
// Read-only local check. Desktop artwork never gets copied into the repository.
const fs=require('node:fs');
const path=require('node:path');
const {raster,referencePixels}=require('../../../agent/siparis/autoMeasure');
async function check(root) {
  const records=JSON.parse(fs.readFileSync(path.join(root,'duz-cizimler.json'),'utf8')),results=[];
  for(const record of records) {
    const start=performance.now(),image=await raster({buffer:fs.readFileSync(path.join(root,record.dosya)),mime:'image/png'});
    const {chestPx}=referencePixels(image,record.urun);
    results.push({ad:record.ad,chestPx,refLengthPx:record.refLengthPx,differencePercent:Number(((chestPx/record.refLengthPx-1)*100).toFixed(2)),ms:Math.round(performance.now()-start)});
  }
  return results;
}
if(require.main===module)check(process.argv[2]).then(results=>console.log(JSON.stringify(results,null,2))).catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={check};
