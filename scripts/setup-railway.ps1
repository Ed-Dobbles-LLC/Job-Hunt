# ============================================================
# One-time Railway + GitHub setup for Asset-Manager
# Run this in PowerShell where you have Railway CLI access.
# After this, every push to main auto-deploys.
# ============================================================

$ErrorActionPreference = "Stop"

Write-Host "`n=== Asset-Manager Railway Setup ===" -ForegroundColor Cyan

# --- Step 1: Verify Railway CLI ---
Write-Host "`n[1/6] Checking Railway CLI..." -ForegroundColor Yellow
try {
    $railwayVersion = railway --version
    Write-Host "  OK: $railwayVersion" -ForegroundColor Green
} catch {
    Write-Host "  Railway CLI not found. Install: https://docs.railway.app/guides/cli" -ForegroundColor Red
    exit 1
}

# --- Step 2: Verify Railway auth ---
Write-Host "`n[2/6] Checking Railway auth..." -ForegroundColor Yellow
try {
    $whoami = railway whoami 2>&1
    Write-Host "  OK: Logged in as $whoami" -ForegroundColor Green
} catch {
    Write-Host "  Not logged in. Running: railway login" -ForegroundColor Yellow
    railway login
}

# --- Step 3: Create Railway project ---
Write-Host "`n[3/6] Creating Railway project..." -ForegroundColor Yellow
$projectName = "asset-manager"

# Init project (or link existing)
try {
    $initResult = railway init --name $projectName --json 2>&1
    $projectData = $initResult | ConvertFrom-Json
    $projectId = $projectData.id
    Write-Host "  Created project: $projectName (ID: $projectId)" -ForegroundColor Green
} catch {
    Write-Host "  Project may already exist. Linking..." -ForegroundColor Yellow
    railway link
    $projectId = (railway status --json 2>&1 | ConvertFrom-Json).projectId
    Write-Host "  Linked to project ID: $projectId" -ForegroundColor Green
}

# --- Step 4: Add PostgreSQL database ---
Write-Host "`n[4/6] Adding PostgreSQL database..." -ForegroundColor Yellow
try {
    railway add --database postgres
    Write-Host "  PostgreSQL database added" -ForegroundColor Green
} catch {
    Write-Host "  Database may already exist, continuing..." -ForegroundColor Yellow
}

# --- Step 5: Set environment variables ---
Write-Host "`n[5/6] Setting environment variables..." -ForegroundColor Yellow
Write-Host "  Enter values (press Enter to skip optional ones):" -ForegroundColor Gray

$envVars = @{}

# Required
$val = Read-Host "  OPENAI_API_KEY (required)"
if ($val) { $envVars["OPENAI_API_KEY"] = $val }

$val = Read-Host "  GOOGLE_CLIENT_ID (required for Gmail)"
if ($val) { $envVars["GOOGLE_CLIENT_ID"] = $val }

$val = Read-Host "  GOOGLE_CLIENT_SECRET (required for Gmail)"
if ($val) { $envVars["GOOGLE_CLIENT_SECRET"] = $val }

$val = Read-Host "  GOOGLE_REFRESH_TOKEN (required for Gmail)"
if ($val) { $envVars["GOOGLE_REFRESH_TOKEN"] = $val }

$val = Read-Host "  GMAIL_LABEL [Job Alerts]"
if ($val) { $envVars["GMAIL_LABEL"] = $val } else { $envVars["GMAIL_LABEL"] = "Job Alerts" }

$val = Read-Host "  DIGEST_EMAIL (required)"
if ($val) { $envVars["DIGEST_EMAIL"] = $val }

$val = Read-Host "  INNGEST_EVENT_KEY"
if ($val) { $envVars["INNGEST_EVENT_KEY"] = $val }

$val = Read-Host "  INNGEST_SIGNING_KEY"
if ($val) { $envVars["INNGEST_SIGNING_KEY"] = $val }

# Optional
$val = Read-Host "  IMPORT_API_KEY (optional, for /api/import-emails)"
if ($val) { $envVars["IMPORT_API_KEY"] = $val }

$val = Read-Host "  CLAY_WEBHOOK_URL (optional)"
if ($val) { $envVars["CLAY_WEBHOOK_URL"] = $val }

# Fixed values
$envVars["NODE_ENV"] = "production"
$envVars["WORKSPACE_ROOT"] = "/app"

foreach ($kv in $envVars.GetEnumerator()) {
    railway variable set "$($kv.Key)=$($kv.Value)" 2>&1 | Out-Null
    Write-Host "  Set: $($kv.Key)" -ForegroundColor Green
}

# --- Step 6: Create Railway API token and set as GitHub secret ---
Write-Host "`n[6/6] Setting up GitHub Actions deployment..." -ForegroundColor Yellow

# Get service ID for deployment
try {
    $statusJson = railway status --json 2>&1 | ConvertFrom-Json
    $serviceId = $statusJson.serviceId
    Write-Host "  Service ID: $serviceId" -ForegroundColor Green
} catch {
    Write-Host "  Could not get service ID. You may need to set RAILWAY_SERVICE_ID manually." -ForegroundColor Yellow
    $serviceId = ""
}

Write-Host "`n  To enable auto-deploy via GitHub Actions:" -ForegroundColor Cyan
Write-Host "  1. Go to https://railway.app/account/tokens" -ForegroundColor White
Write-Host "  2. Create a token named 'github-actions'" -ForegroundColor White
Write-Host "  3. Run these commands:" -ForegroundColor White
Write-Host ""
Write-Host "     gh secret set RAILWAY_TOKEN --body <your-token> --repo EdDobblesAI/Asset-Manager" -ForegroundColor Gray
if ($serviceId) {
    Write-Host "     gh secret set RAILWAY_SERVICE_ID --body $serviceId --repo EdDobblesAI/Asset-Manager" -ForegroundColor Gray
}
Write-Host ""

# --- Step 7: Generate public domain ---
Write-Host "[Bonus] Generating public domain..." -ForegroundColor Yellow
try {
    $domainResult = railway domain 2>&1
    Write-Host "  Public URL: $domainResult" -ForegroundColor Green
} catch {
    Write-Host "  Run 'railway domain' manually to generate a public URL" -ForegroundColor Yellow
}

# --- Step 8: Deploy ---
Write-Host "`n[Deploy] Deploying now..." -ForegroundColor Yellow
railway up --detach

Write-Host "`n=== Setup complete! ===" -ForegroundColor Cyan
Write-Host "Your dashboard will be live at the Railway domain above." -ForegroundColor White
Write-Host "Push to main to trigger auto-deploys via GitHub Actions.`n" -ForegroundColor White
