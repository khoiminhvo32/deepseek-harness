'use strict'
function sessionValid(session) { if (session.expiry === undefined) return true; return session.expiry > Date.now() }
module.exports = { sessionValid }
