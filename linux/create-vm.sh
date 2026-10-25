#!/usr/bin/env bash
# Creates the scraper's VM in Google Cloud, Tel Aviv region. Run it in Cloud Shell (the >_
# button at the top of console.cloud.google.com) with your project selected:
#
#   bash create-vm.sh
#
# What it makes, and why:
#   - a network of its own that lets in only Google's IAP (the console's SSH button). The
#     default network lets SSH in from anywhere;
#   - a VM with NO public address (e2-medium, Debian 13, Secure Boot + vTPM on, no Google
#     service account, OS Login). The vTPM is what the vault key is sealed to;
#   - Cloud NAT with one reserved address: the VM reaches the banks and the app from that
#     fixed address, so the banks always see the same one.
# Roughly $33/month in all (the VM ~$27, the address ~$3.65, the disk ~$2.20, NAT ~$1).
# Safe to run again: it skips what already exists.
#
# A copy that passed through Windows has CRLF line endings, which bash cannot run (it stops
# below with "invalid option name"). Remove them and start again. The " #" ending this line
# turns a trailing CR into part of a comment, so the line itself runs either way; everything
# above it is comments, which a CR cannot break either.
if grep -q $'\r' "$0" 2>/dev/null; then sed -i 's/\r//g' "$0" && echo "(Removed the Windows line endings from $0; starting again.)" && exec bash "$0" "$@"; fi #
set -euo pipefail
NAME=finance-scraper
REGION=me-west1
ZONE=me-west1-a

die() { printf '\n✗ %s\n' "$*" >&2; exit 1; }
exists() { "$@" >/dev/null 2>&1; }

PROJECT=$(gcloud config get-value project 2>/dev/null || true)
[ -n "$PROJECT" ] || die "No project selected. Run: gcloud config set project <your-project-ID>   (the ID, not the name)"
echo "Project: $PROJECT · region: $REGION (Tel Aviv)"

echo "Turning on Compute Engine and IAP (a minute or two the first time)…"
gcloud services enable compute.googleapis.com iap.googleapis.com \
  || die "Could not turn on Compute Engine. Billing must be enabled for $PROJECT (console → Billing)."

exists gcloud compute networks describe "$NAME-net" \
  || gcloud compute networks create "$NAME-net" --subnet-mode=custom
exists gcloud compute networks subnets describe "$NAME-subnet" --region="$REGION" \
  || gcloud compute networks subnets create "$NAME-subnet" --network="$NAME-net" --region="$REGION" --range=10.20.0.0/24
exists gcloud compute firewall-rules describe "$NAME-ssh-iap" \
  || gcloud compute firewall-rules create "$NAME-ssh-iap" --network="$NAME-net" --direction=INGRESS --action=allow \
       --rules=tcp:22 --source-ranges=35.235.240.0/20

exists gcloud compute addresses describe "$NAME-ip" --region="$REGION" \
  || gcloud compute addresses create "$NAME-ip" --region="$REGION"
exists gcloud compute routers describe "$NAME-router" --region="$REGION" \
  || gcloud compute routers create "$NAME-router" --network="$NAME-net" --region="$REGION"
exists gcloud compute routers nats describe "$NAME-nat" --router="$NAME-router" --region="$REGION" \
  || gcloud compute routers nats create "$NAME-nat" --router="$NAME-router" --region="$REGION" \
       --nat-external-ip-pool="$NAME-ip" --nat-all-subnet-ip-ranges --min-ports-per-vm=2048

exists gcloud compute instances describe "$NAME" --zone="$ZONE" \
  || gcloud compute instances create "$NAME" --zone="$ZONE" --machine-type=e2-medium \
       --image-family=debian-13 --image-project=debian-cloud --boot-disk-size=20GB --boot-disk-type=pd-balanced \
       --shielded-secure-boot --shielded-vtpm --shielded-integrity-monitoring \
       --no-service-account --no-scopes \
       --subnet="$NAME-subnet" --no-address \
       --metadata=enable-oslogin=TRUE

IP=$(gcloud compute addresses describe "$NAME-ip" --region="$REGION" --format='value(address)')
echo
echo "✓ The VM is ready. The banks will see the address $IP."
echo "  Next: Compute Engine → VM instances → $NAME → SSH"
echo "  (or from here: gcloud compute ssh $NAME --zone=$ZONE --tunnel-through-iap),"
echo "  then scripts/scrape/README.md, \"The scraper box\", step 3."
