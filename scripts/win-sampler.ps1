param(
  [Parameter(Mandatory = $true)][string]$TrackFile,
  [int]$IntervalMs = 3000
)

$ErrorActionPreference = 'SilentlyContinue'
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)

while ($true) {
  $ids = @()
  try {
    if (Test-Path -LiteralPath $TrackFile) {
      $raw = Get-Content -LiteralPath $TrackFile -Raw -Encoding UTF8
      if ($raw -and $raw.Trim()) {
        $parsed = $raw | ConvertFrom-Json
        if ($parsed.pids) { $ids = @($parsed.pids) }
      }
    }
  } catch { }

  $items = New-Object System.Collections.ArrayList
  foreach ($procId in $ids) {
    try {
      $p = Get-Process -Id ([int]$procId) -ErrorAction Stop
      $cpu = 0.0
      try { $cpu = [double]$p.CPU } catch { $cpu = 0.0 }
      [void]$items.Add([pscustomobject]@{
          pid     = [int]$procId
          cpu     = $cpu
          ws      = [long]$p.WorkingSet64
          priv    = [long]$p.PrivateMemorySize64
          threads = [int]$p.Threads.Count
          handles = [int]$p.HandleCount
        })
    } catch {
      [void]$items.Add([pscustomobject]@{ pid = [int]$procId; alive = $false })
    }
  }

  $payload = [pscustomobject]@{
    t     = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    items = @($items)
  }

  try {
    [Console]::Out.WriteLine(($payload | ConvertTo-Json -Compress -Depth 4))
    [Console]::Out.Flush()
  } catch { }

  Start-Sleep -Milliseconds $IntervalMs
}
