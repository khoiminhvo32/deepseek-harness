'use strict'
const { execSync } = require('node:child_process')
function buildReport(user) { return execSync(`node stats.js --user ${user}`, { encoding: 'utf8' }) }
module.exports = { buildReport }
