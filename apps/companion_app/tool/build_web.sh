#!/usr/bin/env bash
# Build the deployed companion using its existing public FlutterFire web app.
# This script does not deploy or enable generation.
set -euo pipefail
cd "$(dirname "$0")/.."
build_defines="$(mktemp -t halloween-web-defines)"
trap 'rm -f "$build_defines"' EXIT
python3 - "$build_defines" <<'PY'
import json, pathlib, re, sys
source = pathlib.Path('lib/firebase_options.dart').read_text()
web = source.split('static const FirebaseOptions web = FirebaseOptions(', 1)[1].split(');', 1)[0]
def field(name):
    match = re.search(r"\b" + name + r":\s*'([^']+)'", web)
    if not match:
        raise SystemExit('Missing public FlutterFire web field: ' + name)
    return match.group(1)
defines = {
    'COMPANION_FIREBASE_API_KEY': field('apiKey'),
    'COMPANION_FIREBASE_APP_ID': field('appId'),
    'COMPANION_FIREBASE_PROJECT_ID': field('projectId'),
    'COMPANION_FUNCTIONS_REGION': 'us-central1',
}
pathlib.Path(sys.argv[1]).write_text(json.dumps(defines))
PY
flutter build web --release --dart-define-from-file="$build_defines" "$@"
