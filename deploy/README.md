# Cloud Run deploy — one-time setup

What `.github/workflows/deploy.yml` assumes already exists. Everything here is
run once, by hand, by someone with owner on `antiphony-core`. None of it is
automated on purpose: it grants IAM, and IAM grants are not a thing a CI workflow
should be able to widen.

This is **the live deploy.** Cloud Run serves `api.antiphony.dev`; Firebase App
Hosting was retired at the § 7 cutover and `apphosting.yaml` is deleted, so
`deploy/cloudrun.env.yaml` is the single authoritative description of what
production runs. Steps 1–5 are historical record — they are already done, and are
kept because they are what you would re-run to stand this up in a fresh project.

```bash
export PROJECT_ID=antiphony-core
export REGION=us-east4
export REPOSITORY=antiphony
export SERVICE=antiphony-core-api
export GITHUB_REPO=bbthorson/antiphony
```

## 1. Artifact Registry

```bash
gcloud artifacts repositories create "$REPOSITORY" \
  --repository-format=docker --location="$REGION" --project="$PROJECT_ID" \
  --description="Antiphony container images"
```

## 2. Runtime service account

The identity the container runs as. These are the same roles the App Hosting
compute account held — the migration did not change what the service is allowed
to do.

```bash
gcloud iam service-accounts create antiphony-core-api \
  --display-name="Antiphony core-api (Cloud Run runtime)" --project="$PROJECT_ID"

export RUNTIME_SA="antiphony-core-api@${PROJECT_ID}.iam.gserviceaccount.com"

for ROLE in roles/datastore.user roles/storage.objectAdmin roles/cloudtasks.enqueuer; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${RUNTIME_SA}" --role="$ROLE"
done
```

The signed-URL grant is the one that looks wrong and is not — the account needs
`serviceAccountTokenCreator` **on itself**. V4 signed URLs under Application
Default Credentials are produced by calling `signBlob` against its own identity,
so without this the audio proxy's `getSignedUrl` fails at runtime while every
other Storage call keeps working:

```bash
gcloud iam service-accounts add-iam-policy-binding "$RUNTIME_SA" \
  --member="serviceAccount:${RUNTIME_SA}" \
  --role=roles/iam.serviceAccountTokenCreator --project="$PROJECT_ID"
```

Secret access is granted per secret rather than project-wide, so the list of what
this service can read stays legible:

```bash
for SECRET in antiphony-app-tokens system-auth-token elevenlabs-api-key; do
  gcloud secrets add-iam-policy-binding "$SECRET" \
    --member="serviceAccount:${RUNTIME_SA}" \
    --role=roles/secretmanager.secretAccessor --project="$PROJECT_ID"
done
```

## 3. Deploy service account

What GitHub Actions impersonates. Separate from the runtime account so a
compromised CI token cannot read Firestore or mint signed URLs — it can only ship
images and move traffic.

```bash
gcloud iam service-accounts create github-deploy \
  --display-name="GitHub Actions deployer" --project="$PROJECT_ID"

export DEPLOY_SA="github-deploy@${PROJECT_ID}.iam.gserviceaccount.com"

for ROLE in roles/run.admin roles/artifactregistry.writer; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${DEPLOY_SA}" --role="$ROLE"
done
```

Deploying a service that *runs as* another account requires permission to act as
that account. This binding is on the runtime account, not the project, so the
deployer can only impersonate this one identity:

```bash
gcloud iam service-accounts add-iam-policy-binding "$RUNTIME_SA" \
  --member="serviceAccount:${DEPLOY_SA}" \
  --role=roles/iam.serviceAccountUser --project="$PROJECT_ID"
```

## 4. Workload Identity Federation

Lets the workflow's OIDC token stand in for the deploy account, so no
service-account key is ever created or stored. A stored key is a long-lived
credential that works from anywhere; this one works only from this repo.

```bash
gcloud iam workload-identity-pools create github \
  --location=global --display-name="GitHub Actions" --project="$PROJECT_ID"

gcloud iam workload-identity-pools providers create-oidc github \
  --location=global --workload-identity-pool=github \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" \
  --attribute-condition="assertion.repository=='${GITHUB_REPO}'" \
  --project="$PROJECT_ID"
```

The `--attribute-condition` is load-bearing. Without it the provider trusts
*every* repository on GitHub, and anyone's workflow can request a token for this
project.

```bash
export PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
export POOL="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github"

gcloud iam service-accounts add-iam-policy-binding "$DEPLOY_SA" \
  --member="principalSet://iam.googleapis.com/${POOL}/attribute.repository/${GITHUB_REPO}" \
  --role=roles/iam.workloadIdentityUser --project="$PROJECT_ID"
```

## 5. GitHub repository variables

Settings → Secrets and variables → Actions → **Variables**. These are
identifiers, not credentials — a variable rather than a secret so the workflow
log stays readable.

```bash
echo "GCP_WORKLOAD_IDENTITY_PROVIDER = ${POOL}/providers/github"
echo "GCP_DEPLOY_SERVICE_ACCOUNT     = ${DEPLOY_SA}"
echo "GCP_RUNTIME_SERVICE_ACCOUNT    = ${RUNTIME_SA}"
```

## 6. First deploy, without taking traffic

Run **Deploy core-api** from the Actions tab with `promote` unchecked. The
workflow builds, deploys with `--no-traffic`, and smoke-tests the candidate URL —
so a boot failure surfaces against a revision nobody is using. `api.antiphony.dev`
is untouched throughout.

The first run against a service that does not exist yet is a special case, and
it is already handled — no manual bootstrap needed. **Answered by run
[31316275817](https://github.com/bbthorson/antiphony/actions/runs/31316275817):**
gcloud rejects the flag outright rather than warning or ignoring it —

```
ERROR: (gcloud.run.deploy) --no-traffic not supported when creating a new service.
```

— because there is no prior revision for the withheld traffic to stay on. The
workflow now detects a missing service and drops `--no-traffic --tag` for that
one run, so the first revision serves immediately. That is safe precisely
because it is the first: no domain mapping exists, so nothing routes to it. The
smoke test still gates, probing the service URL instead of a tag URL, and the
promote step is skipped since that revision already holds all the traffic.

Note also that after any `--no-traffic` deploy, LATEST stops receiving traffic
automatically on future deploys. That is why the workflow promotes by explicit
revision name rather than `--to-latest`, and it is the intended end state, not
drift.

### The enrichment queue — half tested, deliberately

The Cloud Tasks → Cloud Run direction is **verified**. Enqueueing a task straight
at the worker route needs no env change and mutates nothing, so it is worth
re-running after any change to the runtime service account or the system token:

```bash
TOKEN="$(gcloud secrets versions access latest --secret=system-auth-token --project="$PROJECT_ID")"
gcloud tasks create-http-task \
  --queue=antiphony-processing --location="$REGION" --project="$PROJECT_ID" \
  --url="$(gcloud run services describe "$SERVICE" --region "$REGION" \
      --project "$PROJECT_ID" --format='value(status.url)')/api/v1/system/process-audio" \
  --method=POST \
  --header="Authorization: Bearer ${TOKEN}" \
  --header="Content-Type: application/json" \
  --body-content='{"originAppId":"voxpop","postId":"queue-probe-does-not-exist"}'
```

A nonexistent `postId` is the point: the run should reach Firestore, fail to
claim a lease, and log `[audio-processing] lease not acquired`. That single line
proves routing, `SYSTEM_AUTH_TOKEN`, and Firestore access from the runtime
service account all work. The request log shows `200` with user agent
`Google-Cloud-Tasks`; an unauthenticated `curl` to the same route gives `401`.

```bash
gcloud logging read \
  'resource.type=cloud_run_revision AND resource.labels.service_name='"$SERVICE" \
  --project "$PROJECT_ID" --limit 10 --freshness=10m \
  --format='value(jsonPayload.msg,jsonPayload.postId)'
```

The **enqueue** direction is not tested and is not worth forcing.
`ANTIPHONY_TASKS_WORKER_URL` names `api.antiphony.dev`, so jobs created through
Cloud Run are still executed by App Hosting until step 7 — harmless, since both
run the same code against the same Firestore. Exercising it early would mean
creating a real post with audio, which writes to production Firestore for the
sake of a path that becomes correct on its own at cutover. The seam that could
not be inferred is the one already tested above.

## 7. Cut the domain over

**`api.antiphony.dev` is already behind Cloudflare.** It resolves to Cloudflare
addresses (104.21.x / 172.67.x) and answers with `server: cloudflare` and a
`cf-ray` header, with `via: 1.1 google` underneath — Cloudflare is proxying to
App Hosting as the origin. So this is **not** a DNS change and **not** a Google
domain mapping: it is a change of origin inside Cloudflare, and the rest of this
section is about doing that without a 404.

That makes the cutover better than a DNS move in every way that matters here —
no propagation wait, and rollback is flipping the origin back, in seconds.

An earlier revision of this file prescribed `gcloud beta run domain-mappings
create` without checking how the name actually resolves. It would not have
broken anything, but it was the wrong mechanism for this setup.

### The failure mode to design around

Cloud Run routes by `Host`. Point Cloudflare at the `*.run.app` origin while it
still forwards `Host: api.antiphony.dev`, and Google's frontend matches no
service and returns its own **404** — before the container is ever reached.
Verified against the live service:

```bash
# 200 — Host matches the run.app name
curl -s -o /dev/null -w '%{http_code}\n' https://<service>-<hash>-uk.a.run.app/health
# 404 — Google's frontend error page, not the app
curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: api.antiphony.dev' \
  https://<service>-<hash>-uk.a.run.app/health
```

The 404 is indistinguishable at a glance from a broken deploy, so know it on
sight: an HTML error page from Google rather than this API's JSON envelope means
`Host`, not the service.

Two ways to resolve it. Pick one — they are alternatives, not steps.

### Option A — rewrite the Host at Cloudflare (no GCP prerequisites)

Point the `api` record at the `*.run.app` hostname (proxied), then add a
Cloudflare **Origin Rule** that overrides the Host header to that same
`*.run.app` hostname. Nothing changes in GCP.

Check two things in the dashboard, both of which vary by plan and neither of
which is verified here:

- **Host Header override** must be available in Origin Rules on this plan.
- **SSL/TLS mode must be Full (strict)**, and the origin certificate is
  `*.run.app`. If Cloudflare presents SNI for `api.antiphony.dev` rather than the
  origin hostname, strict verification fails — an SNI override is the fix, and on
  some plans that is not offered. If it is not, use Option B.

### Option B — teach Cloud Run the hostname (keeps Cloudflare config vanilla)

Create a managed domain mapping so Cloud Run itself accepts
`Host: api.antiphony.dev`, then point Cloudflare's origin at the mapping target.
Cloudflare then proxies unmodified, exactly as it does to App Hosting today.

Confirmed: `us-east4` **is** a supported region for domain mappings (the
supported set is `asia-east1`, `asia-northeast1`, `asia-southeast1`,
`europe-north1`, `europe-west1`, `europe-west4`, `us-central1`, `us-east1`,
`us-east4`, `us-west1`).

The prerequisite is domain verification, and it is not done:
`gcloud domains list-user-verified` returns `bradandmatt.com`, `kalamos.care`,
`phonicfactory.com`, `scope.cards` — **not `antiphony.dev`**. Verify it first, or
this fails on ownership rather than on region.

```bash
gcloud domains verify antiphony.dev            # one-time, follow the prompts
gcloud components install beta                  # domain-mappings is a beta surface
gcloud beta run domain-mappings create --service="$SERVICE" \
  --domain=api.antiphony.dev --region="$REGION" --project="$PROJECT_ID"
```

### Ordering

`ANTIPHONY_PDS_HOST` is `api.antiphony.dev`, and the boot gate refuses to start
unless each tenant's `did:web` names that host — so the name has to keep
resolving to *something* serving this code throughout. Switch the origin before
deleting the App Hosting backend, never the reverse.

`ANTIPHONY_TASKS_WORKER_URL` needs no edit. It already names
`api.antiphony.dev`, so it becomes correct the moment the origin flips — until
then, jobs enqueued by Cloud Run are executed by App Hosting, which is harmless
(same code, same Firestore) but means the enqueue path is not exercised until
cutover. The Cloud Tasks → Cloud Run direction has been tested independently.

### Verifying the flip

`/health` reports the commit it was built from, and the two deployments disagree:
App Hosting reports `sha: "dev"` (its buildpack never injected `COMMIT_SHA`),
while the container reports a real 40-character sha. So one request tells you
which is serving:

```bash
curl -s https://api.antiphony.dev/health
```

A real sha means the cutover took.

## Rollback

Revisions are immutable and traffic is a pointer, so a rollback is a traffic
change and takes effect in seconds — no rebuild:

```bash
gcloud run revisions list --service="$SERVICE" --region="$REGION" --project="$PROJECT_ID"
gcloud run services update-traffic "$SERVICE" --region="$REGION" --project="$PROJECT_ID" \
  --to-revisions=PREVIOUS_REVISION=100
```

## Locking the origin to Cloudflare

`api.antiphony.dev` goes through Cloudflare, but the Cloud Run default hostname
`*.run.app` stays publicly reachable and answers the same routes — so the WAF,
DDoS absorption, and bot rules are one hostname away from being skipped.

`middleware/origin-lock.ts` closes that: every `/api/v1/*` request must carry a
secret header Cloudflare injects at the edge. `/`, `/health`, and
`/openapi.json` stay open on both hostnames on purpose — § 6's smoke test probes
`/health` on a candidate revision's tag URL, which by definition is not yet
behind Cloudflare.

**Disabling the default URL would be a stronger lock and is deliberately not
what this does.** `--no-default-url` removes the candidate tag URL too, and with
it the pre-promotion gate that exists because boot is fail-closed on did:web
resolution. Also note `--ingress=internal-and-cloud-load-balancing` is NOT an
option here: Cloudflare reaches this service over the public internet via
`ghs.googlehosted.com`, not a Google load balancer, so restricting ingress takes
production down.

### The order is load-bearing

The enforcing side (Cloud Run) and the header-adding side (Cloudflare) cannot
land atomically. **Set the secret before Cloudflare injects the header and every
`/api/v1/*` request 403s** — the whole API, every tenant. The middleware fails
OPEN when the var is absent precisely so these steps can be taken one at a time.

**1. Generate a value and teach Cloudflare to send it.** In the dashboard:
Rules → Transform Rules → Modify Request Header → *Set static* on the zone,
header `x-antiphony-origin`, value below. Applies to all requests to this
hostname, including the Cloud Tasks callbacks (they arrive via
`api.antiphony.dev`, so they inherit it).

```bash
openssl rand -hex 32
```

**2. Verify Cloudflare is actually sending it before enforcing anything.** The
lock is still open, so a wrong answer here costs nothing:

```bash
curl -s https://api.antiphony.dev/api/v1/audio | head -c 200   # still 400, lock open
gcloud logging read 'resource.type=cloud_run_revision AND resource.labels.service_name=antiphony-core-api AND jsonPayload.msg=~"origin-lock"' \
  --project antiphony-core --limit 5 --freshness=10m --format='value(jsonPayload.msg)'
```

**3. Create the secret and grant the runtime SA access.**

```bash
printf '%s' '<the value from step 1>' | gcloud secrets create antiphony-origin-secret \
  --data-file=- --project=antiphony-core

gcloud secrets add-iam-policy-binding antiphony-origin-secret \
  --member="serviceAccount:antiphony-core-api@antiphony-core.iam.gserviceaccount.com" \
  --role=roles/secretmanager.secretAccessor --project=antiphony-core
```

**4. Wire it and deploy.** Append to the `--set-secrets` list in
`.github/workflows/deploy.yml`:

```
ANTIPHONY_ORIGIN_SECRET=antiphony-origin-secret:latest
```

Enforcement begins with that revision. The ref is intentionally absent until
here — a `--set-secrets` entry for a secret that does not exist fails the
deploy.

### Verifying the lock

Both must hold. Through Cloudflare still works; direct is refused:

```bash
curl -s -o /dev/null -w 'via cloudflare: %{http_code}\n' https://api.antiphony.dev/api/v1/audio
curl -s -o /dev/null -w 'direct:         %{http_code}\n' \
  "$(gcloud run services describe antiphony-core-api --region us-east4 --project antiphony-core --format='value(status.url)')/api/v1/audio"
```

Expect `400` (the route's own missing-param error, i.e. it got through) and
`403`. A `403` on the first line means Cloudflare is not injecting the header —
roll back by removing the `--set-secrets` entry and redeploying, then fix the
Transform Rule.

### Rotation

Same order: add the new value at Cloudflare first, then update the secret and
redeploy. There is a brief window where one side is ahead of the other, so
rotate during low traffic. The middleware accepts a single value by design —
multi-value parsing is not carried for a case that has not come up.
