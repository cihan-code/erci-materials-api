'use strict';
async function manual() { return { status: 'manuel_bekliyor' }; }
module.exports = { manual, createManualHandler: () => manual };
