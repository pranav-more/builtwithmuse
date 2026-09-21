"use strict";

// Every /api/* request on Vercel is rewritten here (vercel.json) and served by
// the shared handler.
const { handle } = require("../lib/api");

module.exports = (req, res) => handle(req, res);
