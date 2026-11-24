param(
    [Parameter(Mandatory = $true, ValueFromRemainingArguments = $true)]
    [string[]]$ComposeArgs
)

$ErrorActionPreference = "Stop"
$Root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
if ($Root -notmatch '^(?<drive>[A-Za-z]):\\(?<path>.*)$') {
    throw "Nao foi possivel converter a raiz do projeto para o caminho do WSL: $Root"
}

$drive = $Matches.drive.ToLowerInvariant()
$relativePath = $Matches.path -replace '\\', '/'
$linuxRoot = "/mnt/$drive/$relativePath"
$wslArgs = @("-d", "Ubuntu", "--cd", $linuxRoot, "--", "docker", "compose") + $ComposeArgs

& wsl.exe @wslArgs
if ($LASTEXITCODE -ne 0) {
    throw "Docker Compose no Ubuntu WSL falhou (exit code $LASTEXITCODE)."
}
