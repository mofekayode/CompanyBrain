#!/bin/zsh
# Captures every demo screen of the client app (headless Chrome) for the landing page.
# Needs: API on :4318, client on :4320, worker running. Output: apps/site/screenshots/product/
#
#   apps/client/scripts/capture-demos.sh [width] [scale]     defaults: 1440 2 (retina)

W=${1:-1440}
S=${2:-2}
OUT="$(cd "$(dirname "$0")/../../site" && pwd)/screenshots/product"
BASE=http://localhost:4320/riverton
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PROFILE=$(mktemp -d)
mkdir -p "$OUT"

shot() { # name height wait_ms url
  rm -rf "$PROFILE"; mkdir -p "$PROFILE"
  perl -e 'alarm 150; exec @ARGV' "$CHROME" --headless=new --disable-gpu --hide-scrollbars --user-data-dir="$PROFILE" \
    --window-size=$W,$2 --force-device-scale-factor=$S --virtual-time-budget=$3 --screenshot="$OUT/$1.png" "$4" 2>/dev/null
  echo "✓ $1"
}
q() { python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$1"; }

shot 00-home                      1500 25000 "$BASE?as=$(q 'Sarah Okafor')"
shot 01-pump17-answer             1500 45000 "$BASE/ask?q=$(q 'Why did Pump 17 keep failing?')&as=$(q 'Sarah Okafor')"
shot 01-pump17-investigation      2400 60000 "$BASE/briefs?skill=incident_investigation&input=$(q 'Pump 17')&as=$(q 'Sarah Okafor')"
shot 02-discounts-now             1300 40000 "$BASE/ask?q=$(q 'Who approves discounts now?')&as=$(q 'Sarah Okafor')"
shot 02-discounts-march-2025      1300 40000 "$BASE/ask?q=$(q 'Who approved discounts in March 2025?')&as=$(q 'Sarah Okafor')"
shot 03-dave-dependencies         2200 50000 "$BASE/briefs?skill=key_person_audit&input=$(q 'Dave Brennan')&as=$(q 'Sarah Okafor')"
shot 04-blue-ridge-entity         2600 40000 "$BASE/e/$(q 'Big Blue')?as=$(q 'Sarah Okafor')"
shot 04-blue-ridge-dossier        2600 60000 "$BASE/briefs?skill=customer_dossier&input=$(q 'Big Blue')&as=$(q 'Sarah Okafor')"
shot 05-salaries-technician       1100 40000 "$BASE/ask?q=$(q "What are everyone's salaries?")&as=$(q 'Jamal Whitaker')"
shot 05-salaries-controller       1300 40000 "$BASE/ask?q=$(q "What are everyone's salaries?")&as=$(q 'Linda Marsh')"
shot 06-search                    1500 30000 "$BASE/search?q=$(q 'the cage')&as=$(q 'Sarah Okafor')"
shot 07-files-technician          1300 30000 "$BASE/files?as=$(q 'Jamal Whitaker')"
shot 08-access-admin              1600 30000 "$BASE/admin?as=$(q 'Sarah Okafor')"
rm -rf "$PROFILE"
echo "→ $OUT"
