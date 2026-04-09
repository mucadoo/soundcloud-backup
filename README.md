# 🎵 SoundCloud Playlist Backup

A serverless AWS Lambda function that automatically backs up your SoundCloud playlists to a JSON file stored on Google Drive. Runs daily on a schedule and incrementally updates the backup, preserving track history even when tracks are removed from SoundCloud.

---

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Prerequisites](#prerequisites)
- [Environment Variables](#environment-variables)
- [Local Development](#local-development)
- [Deployment](#deployment)
- [How It Works](#how-it-works)
- [Backup File Format](#backup-file-format)
- [Infrastructure](#infrastructure)
- [CI/CD Pipeline](#cicd-pipeline)
- [Limitations & Notes](#limitations--notes)

---

## Overview

SoundCloud does not offer an official data export for playlists. This project solves that by:

1. Dynamically extracting a SoundCloud API `client_id` from their public web page (no official API key required)
2. Fetching all playlists for a given user via the SoundCloud internal API
3. Merging new tracks into an existing backup stored in Google Drive
4. Soft-deleting tracks that no longer appear in a playlist (marks `exists: false`) rather than removing them

The Lambda function is triggered once per day via an Amazon EventBridge (CloudWatch Events) rule.

---

## Architecture

```
EventBridge (daily cron)
        │
        ▼
AWS Lambda (Node.js 22)
        │
        ├──► SoundCloud Web (scrape client_id)
        │
        ├──► SoundCloud API v2 (fetch playlists & tracks)
        │
        └──► Google Drive API v3
                ├── GET  (download existing backup JSON)
                └── PUT  (upload updated backup JSON)
```

**Stack:**

- **Runtime:** Node.js 22.x on AWS Lambda
- **Scheduler:** Amazon EventBridge cron (`0 0 * * ? *` — midnight UTC daily)
- **Storage:** Google Drive (single JSON file, overwritten on each run)
- **IaC:** Terraform
- **CI/CD:** GitHub Actions

---

## Prerequisites

- An AWS account with permissions to create Lambda functions, IAM roles, and EventBridge rules
- A Google Cloud project with the **Google Drive API** enabled
- A Google OAuth2 client with a refresh token that has Drive access
- A Google Drive file ID where the backup JSON will be stored (create an empty file first)
- Your SoundCloud **user ID** (visible in profile URLs or via the SoundCloud API)
- Terraform >= 1.0 installed locally (for manual deploys)
- Node.js >= 18.17

---

## Environment Variables

The Lambda function reads all configuration from environment variables. Set these in your Lambda configuration or inject them via your deployment pipeline.

| Variable | Description |
|---|---|
| `GOOGLE_CLIENT_ID` | OAuth2 client ID from Google Cloud Console |
| `GOOGLE_CLIENT_SECRET` | OAuth2 client secret from Google Cloud Console |
| `GOOGLE_REDIRECT_URI` | Authorized redirect URI for the OAuth2 client |
| `GOOGLE_REFRESH_TOKEN` | Long-lived refresh token for Google Drive access |
| `GOOGLE_DRIVE_FILE_ID` | ID of the Google Drive file used to store the backup |
| `SOUNDCLOUD_USER_ID` | Numeric SoundCloud user ID to back up |

> **Getting a Google Refresh Token:** Use the [OAuth 2.0 Playground](https://developers.google.com/oauthplayground) or a local OAuth flow to obtain a refresh token with the `https://www.googleapis.com/auth/drive` scope.

> **Finding your SoundCloud User ID:** Visit `https://api-v2.soundcloud.com/users/<your-username>` in a browser (no auth needed) and copy the `id` field.

---

## Local Development

```bash
# Clone the repo
git clone <your-repo-url>
cd playlist-backup

# Install dependencies
npm install

# Create a .env file with your variables
cp .env.example .env
# Edit .env with your values

# Invoke the handler locally (e.g. with a simple test script)
node -e "require('./app').lambdaHandler({}).then(console.log)"
```

> There is no local SAM/serverless emulation configured. For quick iteration, invoke the handler directly as shown above.

---

## Deployment

Deployment is automated via GitHub Actions on every push to `main`. It zips the Lambda source, configures AWS credentials, and runs `terraform apply`.

### Manual Deployment

```bash
# 1. Package the Lambda
cd playlist-backup
npm install
zip -r ../playlist-backup.zip .
cd ..

# 2. Configure AWS credentials
export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...
export AWS_DEFAULT_REGION=us-east-2

# 3. Deploy with Terraform
terraform init
terraform apply
```

### Required GitHub Secrets

Set these in your repository's **Settings → Secrets and variables → Actions**:

| Secret | Description |
|---|---|
| `AWS_ACCESS_KEY_ID` | IAM user access key with Lambda & IAM deploy permissions |
| `AWS_SECRET_ACCESS_KEY` | Corresponding secret access key |

> **Note:** Lambda environment variables (Google credentials, SoundCloud user ID, etc.) are not managed by this Terraform config. Set them manually in the AWS Console under the Lambda function's **Configuration → Environment variables**, or extend `main.tf` with an `environment` block.

---

## How It Works

### 1. Client ID Extraction (`extractClientIdFromScripts`)

SoundCloud's public API requires a `client_id` parameter. Rather than using a hardcoded value that rotates frequently, the function:

1. Fetches the SoundCloud homepage HTML
2. Parses all `<script src="...">` tags with Cheerio
3. Iterates through each script file, applying a regex to find `client_id: "..."` or `client_id = "..."`
4. Returns the first match found

### 2. Fetching the Existing Backup (`fetchGoogleDriveFile`)

Downloads the current backup JSON from Google Drive using the Drive API v3 (`files.get` with `alt: media`). If no file exists yet, create an empty JSON array (`[]`) manually in Drive first.

### 3. Fetching Playlists (`fetchSoundCloudPlaylists`)

Calls `GET /users/{userId}/playlists_without_albums` on the SoundCloud v2 API. This returns all user-created playlists (excluding albums).

### 4. Merging Data (`updateFileContent`)

For each playlist in the SoundCloud response:

- If the playlist doesn't exist in the backup → create a new entry
- If it does exist → mark all its tracks as `exists: false` (soft-delete baseline)

For each track in the playlist:

- If track data is incomplete (missing `title`) → fetch full details from `GET /tracks?ids={id}`
- If the track doesn't exist in the backup → append it
- If it does exist → mark it as `exists: true` (restores the soft-delete)

Tracks that were once in a playlist but are no longer present remain in the backup with `exists: false`, preserving a historical record.

### 5. Uploading the Result (`uploadFileToGoogleDrive`)

Serializes the updated array to pretty-printed JSON and uploads it to the same Google Drive file ID using `files.update`.

---

## Backup File Format

The backup is stored as a JSON array of playlist objects:

```json
[
  {
    "user": "your-soundcloud-username",
    "name": "playlist-permalink-slug",
    "lastUpdated": "2025-04-09T00:00:00.000Z",
    "tracks": [
      {
        "id": 123456789,
        "name": "Track Title",
        "desc": "Track description or null",
        "authorName": "Artist Full Name",
        "authorNick": "artist-username",
        "authorUrl": "artist-permalink",
        "exists": true
      }
    ]
  }
]
```

| Field | Description |
|---|---|
| `user` | SoundCloud username of the playlist owner |
| `name` | Playlist permalink slug (URL-safe identifier) |
| `lastUpdated` | ISO timestamp of the last sync run |
| `tracks[].id` | SoundCloud track ID |
| `tracks[].name` | Track title |
| `tracks[].desc` | Track description (may be `null`) |
| `tracks[].authorName` | Artist's display name |
| `tracks[].authorNick` | Artist's username |
| `tracks[].authorUrl` | Artist's SoundCloud permalink |
| `tracks[].exists` | `true` if the track is still in the playlist; `false` if it was removed |

---

## Infrastructure

All AWS resources are defined in `main.tf` and provisioned with Terraform.

| Resource | Name | Purpose |
|---|---|---|
| `aws_iam_role` | `SoundcloudRole` | Lambda execution role |
| `aws_iam_role_policy` | `root` | Full-access inline policy (see security note below) |
| `aws_lambda_function` | `PlaylistBackupFn` | The backup Lambda (Node.js 22, 15-min timeout) |
| `aws_cloudwatch_event_rule` | `soundcloud-backup-schedule` | Daily cron trigger (`0 0 * * ? *`) |
| `aws_cloudwatch_event_target` | — | Connects the rule to the Lambda |
| `aws_lambda_permission` | `AllowExecutionFromCloudWatch` | Grants EventBridge permission to invoke the Lambda |

> ⚠️ **Security Note:** The IAM policy currently grants `Action: "*"` on `Resource: "*"`. For production use, scope this down to only the permissions the Lambda actually needs (e.g., `logs:CreateLogGroup`, `logs:PutLogEvents`). Google Drive access is handled client-side via OAuth2 — no AWS resource permissions are needed for it.

---

## CI/CD Pipeline

The GitHub Actions workflow (`.github/workflows/deploy.yml`) runs on every push to `main`:

1. **Checkout** the repository
2. **Set up Node.js 22** and install dependencies
3. **Zip** the `playlist-backup/` directory into `playlist-backup.zip`
4. **Configure AWS credentials** from GitHub Secrets
5. **Set up Terraform** and run `terraform init` + `terraform apply -auto-approve`

> The Terraform state is stored locally by default. For team use or reliability, configure a remote backend (e.g., S3 + DynamoDB lock) in `main.tf`.

---

## Limitations & Notes

- **SoundCloud `client_id` scraping:** This approach is fragile by nature — if SoundCloud changes its JS bundle structure, the regex may stop matching. The function logs which script file the ID was found in, making it easy to debug if it breaks.
- **No Terraform remote state:** The current setup uses local Terraform state. If the GitHub Actions runner is ephemeral, state will be lost between runs. Add an S3 backend to `main.tf` for persistent state.
- **Lambda environment variables not in Terraform:** Credentials are not wired up in `main.tf`. Add an `environment { variables = { ... } }` block to the `aws_lambda_function` resource, sourcing values from Terraform variables or AWS Secrets Manager.
- **Timeout:** The Lambda is configured with a 900-second (15-minute) timeout to accommodate large playlists and the script-scanning step. Average runs should complete well within this limit.
- **Rate limiting:** No explicit rate limiting or retry logic is implemented for SoundCloud API calls. Heavy playlists with many missing track details (requiring individual `fetchTrackDetails` calls) may hit SoundCloud's informal rate limits.