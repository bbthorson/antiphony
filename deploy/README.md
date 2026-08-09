# Cloud Run deploy — one-time setup

What `.github/workflows/deploy.yml` assumes already exists. Everything here is
run once, by hand, by someone with owner on `antiphony-core`. None of it is
automated on purpose: it grants IAM, and IAM grants are not a thing a CI workflow
should be able to widen.

This is a **migration target, not the live deploy.** Firebase App Hosting still
serves `api.antiphony.dev` until step 7. `apphosting.yaml` stays authoritative
until then; after cutover it should be deleted rather than left to rot as a
second, silently-diverging description of production.

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

The identity the container runs as. These are the same roles `apphosting.yaml`
documents for the App Hosting compute account — the migration does not change
what the service is allowed to do.

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

Before promoting, exercise the enrichment queue against the new service.
`ANTIPHONY_TASKS_WORKER_URL` still names `api.antiphony.dev`, which is App
Hosting, so until DNS moves the queue never calls Cloud Run. Point it at the
candidate URL, deploy again, run a job through, then restore it. See the comment
on that variable in `cloudrun.env.yaml`.

## 7. Cut the domain over

**Verify this step before relying on it.** Cloud Run's managed domain mappings
live on the `beta` surface (`gcloud run domain-mappings` on the GA surface is the
Anthos one) and are **not offered in every region** — `us-east4` needs checking.
Run this first; if it errors or the region is unsupported, take the load-balancer
route below instead.

```bash
gcloud components install beta
gcloud beta run domain-mappings create --service="$SERVICE" \
  --domain=api.antiphony.dev --region="$REGION" --project="$PROJECT_ID"
```

Then update DNS to the records it prints, and delete the App Hosting backend once
the new service has held traffic long enough to trust.

If domain mappings are unavailable, put a global external Application Load
Balancer with a serverless NEG in front of the service and point
`api.antiphony.dev` at its anycast IP. More moving parts and a small monthly
cost, but it is the supported path everywhere and it is what you would want
anyway before adding Cloud Armor or a CDN in front of the audio proxy.

Ordering matters here. `ANTIPHONY_PDS_HOST` is `api.antiphony.dev`, and the boot
gate refuses to start unless each tenant's `did:web` points at that host — so the
name has to keep resolving to *something* that serves this code throughout. Map
the domain before deleting the backend, never the reverse.

## Rollback

Revisions are immutable and traffic is a pointer, so a rollback is a traffic
change and takes effect in seconds — no rebuild:

```bash
gcloud run revisions list --service="$SERVICE" --region="$REGION" --project="$PROJECT_ID"
gcloud run services update-traffic "$SERVICE" --region="$REGION" --project="$PROJECT_ID" \
  --to-revisions=PREVIOUS_REVISION=100
```
