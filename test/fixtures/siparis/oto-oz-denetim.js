'use strict';
// Read-only diagnostics. Local artwork and measurements never enter the repo.
// The former chest-reference pixel self-check was retired in G24b.
const fs=require('node:fs');
const path=require('node:path');
const {raster,silhouette}=require('../../../agent/siparis/autoMeasure');
async function check(root) {
  const records=JSON.parse(fs.readFileSync(path.join(root,'duz-cizimler.json'),'utf8')),results=[];
  for(const record of records) {
    const start=performance.now(),image=await raster({buffer:fs.readFileSync(path.join(root,record.dosya)),mime:'image/png'}),shape=silhouette(image);
    const positive=n=>Number.isFinite(n)&&n>0,measurements=record.refBeden==='L'?record.olculerL??{}:{};
    const vertical=shape&&positive(measurements.omuzdan_boy)?measurements.omuzdan_boy*10/shape.bodyHeightPx:null;
    const horizontal=shape&&positive(measurements.etek)?measurements.etek*10/shape.hemWidthPx:null;
    results.push({ad:record.ad,method:'L omuzdan_boy/etek teşhisi; eski göğüs piksel öz denetimi kaldırıldı',bodyHeightPx:shape?.bodyHeightPx??null,hemWidthPx:shape?.hemWidthPx??null,shoulderMethod:shape?.shoulderMethod??null,verticalMmPerPx:vertical,horizontalMmPerPx:horizontal,scaleDifference:vertical&&horizontal?Math.abs(vertical-horizontal)/((vertical+horizontal)/2):null,ms:Math.round(performance.now()-start)});
  }
  return results;
}
if(require.main===module)check(process.argv[2]).then(results=>console.log(JSON.stringify(results,null,2))).catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={check};
