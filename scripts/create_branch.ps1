<#
.SYNOPSIS
    Creates and switches to a new Git branch following the project's naming conventions.
.DESCRIPTION
    Ensures branch names strictly follow the 'feature/<name>' convention (or other valid prefixes like fix/ or chore/).
    Can branch from 'main' or from the current branch.
.PARAMETER Name
    The descriptive name of the branch (e.g., 'storyboard-ui' or 'feature/storyboard-ui').
.PARAMETER Type
    Branch type prefix. Default is 'feature'. Supported: 'feature', 'fix', 'chore', 'docs', 'refactor', 'test'.
.PARAMETER FromCurrent
    If set, branches from the current branch instead of checking out 'main' first.
.EXAMPLE
    .\scripts\create_branch.ps1 storyboard-editor
    .\scripts\create_branch.ps1 -Name budget-widget -Type feature
    .\scripts\create_branch.ps1 -Name fix-asset-hash -Type fix
#>

[CmdletBinding()]
param (
    [Parameter(Position = 0, Mandatory = $false)]
    [string]$Name,

    [Parameter(Mandatory = $false)]
    [ValidateSet("feature", "fix", "chore", "docs", "refactor", "test")]
    [string]$Type = "feature",

    [switch]$FromCurrent
)

$ErrorActionPreference = "Stop"

# Navigate to project root
$rootDir = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $rootDir

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "   Git Branch Creator (nolen-ai-short-assistant)          " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

# Prompt for branch name if not provided
if ([string]::IsNullOrWhiteSpace($Name)) {
    $Name = Read-Host "Enter branch name (e.g. storyboard-workspace or budget-widget)"
    if ([string]::IsNullOrWhiteSpace($Name)) {
        Write-Host "Branch name cannot be empty. Aborted." -ForegroundColor Red
        exit 1
    }
}

# Clean and normalize branch name
$cleanName = $Name.Trim().ToLower() -replace '\s+', '-' -replace '[^a-z0-9\-_/]', ''

# Check if already prefixed
$supportedTypes = @("feature", "feat", "fix", "chore", "docs", "refactor", "test")
$hasPrefix = $false
foreach ($prefix in $supportedTypes) {
    if ($cleanName -match "^$prefix/(.+)$") {
        $cleanName = "$($Matches[1])"
        $Type = if ($prefix -eq "feat") { "feature" } else { $prefix }
        $hasPrefix = $true
        break
    }
}

$branchName = "$Type/$cleanName"

Write-Host "`nTarget Branch: " -NoNewline
Write-Host "$branchName" -ForegroundColor Green

# Check if branch already exists
$branchExists = git branch --list $branchName
if (-not [string]::IsNullOrWhiteSpace($branchExists)) {
    Write-Host "Branch '$branchName' already exists locally." -ForegroundColor Yellow
    $checkout = Read-Host "Switch to existing branch '$branchName'? (Y/N)"
    if ($checkout -match "^[yY]$") {
        git switch $branchName
        Write-Host "Switched to '$branchName'." -ForegroundColor Green
    }
    exit 0
}

# Determine base branch
if (-not $FromCurrent) {
    Write-Host "Switching to 'main' and checking latest updates..." -ForegroundColor Gray
    try {
        git checkout main 2>$null
        # Optionally pull if origin exists and network is reachable
        git pull --rebase origin main 2>$null
    } catch {
        Write-Host "Notice: Could not pull latest 'main' (using local base)." -ForegroundColor DarkGray
    }
} else {
    $current = (git branch --show-current).Trim()
    Write-Host "Branching directly from current branch: '$current'" -ForegroundColor Gray
}

# Create and switch to new branch
Write-Host "Creating and switching to '$branchName'..." -ForegroundColor Cyan
git switch -c $branchName

if ($LASTEXITCODE -eq 0) {
    Write-Host "`nBranch successfully created and checked out: " -NoNewline
    Write-Host "$branchName" -ForegroundColor Green
    Write-Host "You are ready to make changes! Next steps:" -ForegroundColor Cyan
    Write-Host "  1. Make your edits and tests." -ForegroundColor Gray
    Write-Host "  2. Run .\scripts\commit_changes.ps1 to commit with Conventional Commits." -ForegroundColor Gray
    Write-Host "  3. Run .\scripts\create_pr.ps1 to push and open a Pull Request." -ForegroundColor Gray
} else {
    Write-Host "Failed to create branch." -ForegroundColor Red
    exit $LASTEXITCODE
}
