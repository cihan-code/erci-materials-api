'use strict';
// As a preload, model a renderer that retains a referenced resource after replying.
// As a worker, model blocked rendering, lost IPC, and a response larger than pipe buffers.
setInterval(()=>{},1000);
if (require.main===module) process.once('message',()=> {
  if (process.argv[2]==='large') process.send({result:Buffer.alloc(8*1024*1024,0xa5)},()=>process.exit(0));
  if (process.argv[2]==='disconnect') process.disconnect();
  if (process.argv[2]==='exit') process.exit(2);
  // 'hang' deliberately never replies or exits.
});
