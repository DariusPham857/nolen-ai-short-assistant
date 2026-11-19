<#
.SYNOPSIS
    Automated Conventional Commits script for nolen-ai-short-assistant.
.DESCRIPTION
    Stages and commits changes incrementally using Conventional Commits specifications.
.PARAMETER DryRun
    If set, prints the git commands without executing them.
.EXAMPLE
    .\scripts\commit_changes.ps1
    .\scripts\commit_changes.ps1 -DryRun
#>

[CmdletBinding()]
param (
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

# Ensure script runs from project root
$rootDir = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $rootDir

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "   Incremental Conventional Commits Runner               " -ForegroundColor Cyan
Write-Host "   Working Directory: $rootDir                            " -ForegroundColor Cyan
if ($DryRun) {
    Write-Host "   Mode: DRY RUN (No changes will be committed)           " -ForegroundColor Yellow
}
Write-Host "==========================================================" -ForegroundColor Cyan

# Define structured incremental commit batches
$commits = @(
    @{
        Step        = 1
        Scope       = "chore(scripts)"
        Subject     = "chore(scripts): add automated incremental conventional commits runner"
        Body        = "Add commit_changes.ps1 and commit_changes.sh to automate batch conventional commits.`nSupport dry-run mode and clean status logging."
        Files       = @(
            "scripts/commit_changes.ps1",
            "scripts/commit_changes.sh"
        )
    },
    @{
        Step        = 2
        Scope       = "docs(spec)"
        Subject     = "docs(spec): add PRD v1.0 and IT project context baseline"
        Body        = "Add approved PRD v1.0 specification defining DEC-P01 through DEC-P09.`nAdd GIC 2026 Challenge 4 IT project context v1.1 baseline.`nDocument reference directory index."
        Files       = @(
            "docs/PRD/PRD_AI_Short_Film_Assistant_v1.0.md",
            "references/gic-2026/GIC2026_IT_Project_Context_v1.1.md",
            "references/README.md"
        )
    },
    @{
        Step        = 3
        Scope       = "docs(guidelines)"
        Subject     = "docs(guidelines): update AGENTS.md with PRD invariants, IT roles, and design standards"
        Body        = "Enforce non-negotiable business rules: integer-micros ledger (DEC-P02), co-pilot approval gates (DEC-P01), risk-based keyframes (DEC-P03).`nClarify IT1 (Backend/AI/Ledger) and IT2 (Frontend/Media/Reporting) ownership.`nLock demo topology to single-machine localhost with dual LIVE/REPLAY execution modes (DEC-P05).`nReference UI/UX design system in docs/design/."
        Files       = @(
            "AGENTS.md"
        )
    },
    @{
        Step        = 4
        Scope       = "docs(design)"
        Subject     = "docs(design): add UI/UX design system and 6-stage workstation workflow"
        Body        = "Add PRODUCT.md defining personas, 7 core screens, and cinematic studio craft tone.`nAdd DESIGN.md establishing dark-mode zinc/obsidian tokens, typographic hierarchy, and anti-slop rules.`nAdd UI_DESIGN_WORKFLOW.md specifying Three-Pane Workstation layout, status badges, and craft dials."
        Files       = @(
            "docs/design/PRODUCT.md",
            "docs/design/DESIGN.md",
            "docs/design/UI_DESIGN_WORKFLOW.md"
        )
    },
    @{
        Step        = 5
        Scope       = "feat(skills)"
        Subject     = "feat(skills): add ui-design agent skill for workstation authoring"
        Body        = "Introduce reusable agent skill implementing the 6-stage UI design protocol.`nEnforce Three-Pane Workstation layout, token compliance, and anti-slop checks."
        Files       = @(
            ".agents/skills/ui-design/SKILL.md"
        )
    },
    @{
        Step        = 6
        Scope       = "chore(references)"
        Subject     = "chore(references): add benchmark and design reference repositories"
        Body        = "Add clone references for impeccable, hallmark, and taste-skill design suites.`nUsed for anti-slop heuristics, typography benchmarks, and craft guidance."
        Files       = @(
            "references/hallmark",
            "references/impeccable",
            "references/taste-skill"
        )
    }
)

foreach ($commit in $commits) {
    Write-Host "`n----------------------------------------------------------" -ForegroundColor DarkGray
    Write-Host "[$($commit.Step)/$($commits.Count)] Committing: $($commit.Subject)" -ForegroundColor Green
    Write-Host "Files to stage:" -ForegroundColor DarkYellow
    foreach ($file in $commit.Files) {
        Write-Host "  + $file" -ForegroundColor Gray
    }

    if ($DryRun) {
        Write-Host "[DRY RUN] git add $($commit.Files -join ' ')" -ForegroundColor Yellow
        Write-Host "[DRY RUN] git commit -m `"$($commit.Subject)`" -m `"$($commit.Body)`"" -ForegroundColor Yellow
        continue
    }

    # Verify existing files before staging
    $existingFiles = @()
    foreach ($file in $commit.Files) {
        if (Test-Path $file) {
            $existingFiles += $file
        } else {
            Write-Host "  ! Warning: File not found: $file, skipping" -ForegroundColor DarkYellow
        }
    }

    if ($existingFiles.Count -eq 0) {
        Write-Host "  ! No files found for this commit step, skipping." -ForegroundColor Yellow
        continue
    }

    # Stage files
    git add -- $existingFiles

    # Commit with multi-line message
    $commitMsg = "$($commit.Subject)`n`n$($commit.Body)"
    git commit -m $commitMsg

    if ($LASTEXITCODE -ne 0) {
        Write-Host "  ! Commit step failed with exit code $LASTEXITCODE" -ForegroundColor Red
        exit $LASTEXITCODE
    }
}

Write-Host "`n==========================================================" -ForegroundColor Cyan
Write-Host "   Commit process finished successfully!                  " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

if (-not $DryRun) {
    Write-Host "`nRecent Git History:" -ForegroundColor Green
    git log -n ($commits.Count + 1) --oneline --graph
}
