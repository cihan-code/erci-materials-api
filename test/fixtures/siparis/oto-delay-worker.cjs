'use strict';
// Keep a real measurement in flight while HTTP edits change its dependencies.
const send=process.send.bind(process);
process.send=(message,...args)=>setTimeout(()=>send(message,...args),200);
