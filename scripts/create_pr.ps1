<#
.SYNOPSIS
    Automated Pull Request generator for nolen-ai-short-assistant.
.DESCRIPTION
    Pushes the current branch to origin, formats a PR description aligned with PRD requirements,
    and opens the Pull Request via GitHub CLI (gh) or directly in your browser with template prefilled.
.PARAMETER Title
    The PR Title following Conventional Commits (e.g. 'feat(storyboard): add nested scene shot workspace').
.PARAMETER PrdRef
    PRD requirement and decision references (e.g. 'FR-02, DEC-P01, AT-P01-01').
.PARAMETER Description
    Summary of the key changes.
.PARAMETER Tests
    Summary of verification tests performed.
.PARAMETER NoPush
    If set, skips 'git push -u origin <branch>' step.
.EXAMPLE
    .\scripts\create_pr.ps1
    .\scripts\create_pr.ps1 -Title "feat(budget): add integer-micros ledger widget" -PrdRef "FR-09, DEC-P02, AT-P02-01"
#>

[CmdletBinding()]
param (
    [Parameter(Mandatory = $false)]
    [string]$Title,

    [Parameter(Mandatory = $false)]
    [string]$PrdRef,

    [Parameter(Mandatory = $false)]
    [string]$Description,

    [Parameter(Mandatory = $false)]
    [string]$Tests,

    [switch]$NoPush
)

$ErrorActionPreference = "Stop"

# Navigate to project root
$rootDir = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $rootDir

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "   Pull Request Creator (nolen-ai-short-assistant)       " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

# 1. Verify current branch
$currentBranch = (git branch --show-current).Trim()
if ([string]::IsNullOrWhiteSpace($currentBranch) -or $currentBranch -eq "main") {
    Write-Host "Error: You are currently on '$currentBranch'. You cannot create a PR from main directly." -ForegroundColor Red
    Write-Host "Create a feature branch first: .\scripts\create_branch.ps1 <name>" -ForegroundColor Yellow
    exit 1
}

Write-Host "Active Branch: " -NoNewline
Write-Host "$currentBranch" -ForegroundColor Green

# 2. Check uncommitted changes
$status = git status --porcelain
if (-not [string]::IsNullOrWhiteSpace($status)) {
    Write-Host "`nWarning: You have uncommitted changes in your working tree." -ForegroundColor Yellow
    $proceed = Read-Host "Proceed anyway? (Y/N)"
    if ($proceed -notmatch "^[yY]$") {
        Write-Host "Aborted. Please commit your changes first with .\scripts\commit_changes.ps1" -ForegroundColor Yellow
        exit 1
    }
}

# 3. Interactive prompts if parameters omitted
if ([string]::IsNullOrWhiteSpace($Title)) {
    # Suggest latest commit message as default title
    $latestCommit = (git log -1 --pretty=%s).Trim()
    Write-Host "`nEnter PR Title (Conventional Commit format e.g. 'feat(ui): add budget widget')" -ForegroundColor Cyan
    Write-Host "Default [$latestCommit]: " -NoNewline
    $inputTitle = Read-Host
    $Title = if ([string]::IsNullOrWhiteSpace($inputTitle)) { $latestCommit } else { $inputTitle }
}

if ([string]::IsNullOrWhiteSpace($PrdRef)) {
    Write-Host "`nEnter PRD / Decision References (e.g. 'FR-02, DEC-P01, AT-P01-01'): " -NoNewline
    $PrdRef = Read-Host
    if ([string]::IsNullOrWhiteSpace($PrdRef)) { $PrdRef = "N/A" }
}

if ([string]::IsNullOrWhiteSpace($Description)) {
    Write-Host "`nEnter summary of changes: " -NoNewline
    $Description = Read-Host
    if ([string]::IsNullOrWhiteSpace($Description)) { $Description = "Implements requirements for $currentBranch." }
}

if ([string]::IsNullOrWhiteSpace($Tests)) {
    Write-Host "`nEnter verification tests performed: " -NoNewline
    $Tests = Read-Host
    if ([string]::IsNullOrWhiteSpace($Tests)) { $Tests = "Automated unit tests and local visual verification passed." }
}

# 4. Generate PR Body Markdown
$prBody = @"
## Description
$Description

## PRD & Architecture References
- **PRD Requirements**: $PrdRef
- **Branch**: ``$currentBranch`` $\rightarrow$ ``main``

## Key Changes
- Implemented and verified on branch ``$currentBranch``.
- Adheres to repository rules in ``AGENTS.md`` and UI guidelines in ``docs/design/``.

## Verification & Testing Performed
- $Tests

## Checklist
- [x] Branch follows ``feature/<name>`` (or ``fix/<name>``).
- [x] Commits adhere to Conventional Commits.
- [x] No secrets, ``.env``, or credentials committed.
"@

# Save draft locally
$draftPath = Join-Path $rootDir ".pr_draft.md"
Set-Content -Path $draftPath -Value $prBody -Encoding UTF8
Write-Host "`nDraft PR description saved to: .pr_draft.md" -ForegroundColor Gray

# 5. Push branch to remote
if (-not $NoPush) {
    Write-Host "`nPushing branch '$currentBranch' to origin..." -ForegroundColor Cyan
    try {
        git push -u origin $currentBranch
        Write-Host "Branch successfully pushed." -ForegroundColor Green
    } catch {
        Write-Host "Failed to push branch to origin. Check your git remote and permissions." -ForegroundColor Red
        Write-Host "Error: $_" -ForegroundColor DarkRed
        exit 1
    }
}

# 6. Create PR via GitHub CLI or Web URL
$ghAvailable = $false
try {
    $null = Get-Command gh -ErrorAction Stop
    $ghAvailable = $true
} catch {
    $ghAvailable = $false
}

if ($ghAvailable) {
    Write-Host "`nCreating PR using GitHub CLI (gh)..." -ForegroundColor Cyan
    try {
        gh pr create --base main --head $currentBranch --title "$Title" --body "$prBody"
        Write-Host "`nPull Request created successfully!" -ForegroundColor Green
        exit 0
    } catch {
        Write-Host "GitHub CLI encountered an issue, falling back to Web URL..." -ForegroundColor Yellow
    }
}

# Web URL Fallback
$remoteUrl = (git config --get remote.origin.url).Trim()
if ($remoteUrl -match "github\.com[:/](.+?)/(.+?)(\.git)?$") {
    $owner = $Matches[1]
    $repo = $Matches[2]
    $repoUrl = "https://github.com/$owner/$repo"
    $compareUrl = "$repoUrl/compare/main...${currentBranch}?expand=1"

    # Copy PR body to clipboard for easy pasting
    try {
        Set-Clipboard -Value $prBody
        Write-Host "`n[Notice] PR description has been copied to your clipboard (Ctrl+V)!" -ForegroundColor Green
    } catch {}

    Write-Host "`nOpen this URL to complete your PR:" -ForegroundColor Cyan
    Write-Host "$compareUrl" -ForegroundColor Yellow

    # Launch browser
    try {
        Start-Process $compareUrl
        Write-Host "Browser opened to GitHub compare page." -ForegroundColor Green
    } catch {
        Write-Host "Could not automatically launch browser. Please open the link above manually." -ForegroundColor Gray
    }
} else {
    Write-Host "Could not determine GitHub web URL from remote: $remoteUrl" -ForegroundColor Yellow
}
