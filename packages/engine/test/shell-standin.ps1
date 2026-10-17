# Stands in for the desktop shell on Windows the way its Rust code starts the engine: a plain child process
# with piped stdin, outside any job. (Bun puts the processes it starts in a job that ends them with it, so a
# Bun stand-in would take the engine down before it could stop by itself.) It passes on the engine's first
# line, then waits until a test kills it outright, the way a crash or a force-quit ends the app.
# powershell -File shell-standin.ps1 <bun> <cli.ts>
$start = New-Object System.Diagnostics.ProcessStartInfo
$start.FileName = $args[0]
$start.Arguments = '"' + $args[1] + '" app'
$start.UseShellExecute = $false
$start.RedirectStandardInput = $true
$start.RedirectStandardOutput = $true
$start.CreateNoWindow = $true
$engine = [System.Diagnostics.Process]::Start($start)
[Console]::Out.WriteLine($engine.StandardOutput.ReadLine())
[Console]::Out.Flush()
Start-Sleep -Seconds 3600
