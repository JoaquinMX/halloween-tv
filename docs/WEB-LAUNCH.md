# Web companion launch

Live site: <https://halloween-tv.web.app> (Firebase project/site `halloween-tv`).

## Repeatable build and deployment

From the repository root:

```sh
cd apps/companion_app
bash tool/build_web.sh
firebase deploy --project halloween-tv --config firebase.json --only hosting --non-interactive
```

The build script takes public web client configuration from the existing
FlutterFire `lib/firebase_options.dart`. It does not embed operator/provider
credentials, enable generation, deploy Functions, or change the native app.
Hosting serves the Flutter SPA over HTTPS with cache revalidation.

Browser photo selection uses in-memory bytes rather than native file and
temporary-directory APIs. The same explicit consent, upload confirmation,
signed-upload capability, and persisted withdrawal receipts apply. Native
photo selection and staging remain unchanged.

## Storage CORS

The initial bucket had no CORS configuration. `backend/storage.cors.json`
allows only the two Firebase Hosting origins and GET/HEAD/PUT. It does not
make objects public or replace signed-URL authorization. Before reapplying,
inspect the existing bucket CORS and merge any authorized additional origins;
do not overwrite unrelated configuration:

```sh
gcloud storage buckets describe gs://halloween-tv.firebasestorage.app --format=json
gcloud storage buckets update gs://halloween-tv.firebasestorage.app --cors-file=backend/storage.cors.json
```

## Launch boundaries

- Host and guest roles remain separate. Opening the URL does not grant host
  access; host pairing needs a fresh TV Host QR and its six-digit code.
- There are three host slots. An existing diagnostic registration occupies
  one; freeing it is a separate owner decision and never deletes videos.
- Generation remains disabled pending a new explicit bounded allowance.
  Web deployment alone does not reopen the previous paid batch.
- Rotation acceptance and final deployment evidence are tracked separately;
  publishing this site does not by itself verify TV rotation.
