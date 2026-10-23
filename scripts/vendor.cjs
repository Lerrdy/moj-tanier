const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const source = path.join(root, "node_modules/exifr");
const destination = path.join(root, "dist/vendor");
fs.mkdirSync(destination, { recursive: true });
fs.copyFileSync(path.join(source, "dist/full.umd.js"), path.join(destination, "exifr.umd.js"));
fs.copyFileSync(path.join(source, "LICENSE"), path.join(destination, "exifr.LICENSE.txt"));
