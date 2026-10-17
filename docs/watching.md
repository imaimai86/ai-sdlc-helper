# Watching work in progress

To follow several branches being worked on at once (sub-agents or pipeline runs, each in its own worktree under
`../ai-sdlc-helper-sdlc/`), refresh a view of each worktree's last commit and changed files.

## With Node (any OS, nothing to install)

```bash
node -e 'const{execFileSync:x}=require("child_process");const b="../ai-sdlc-helper-sdlc/";const ds=require("fs").readdirSync(b);const g=(d,...a)=>{try{return x("git",["-C",b+d,...a],{encoding:"utf8"}).trim()}catch{return"(not a worktree)"}};const show=()=>{process.stdout.write("\x1bc"+new Date().toLocaleTimeString()+"\n");for(const d of ds)console.log(`== ${d}\n${g(d,"log","--oneline","-1")}\n${g(d,"status","--short").split("\n").slice(0,8).join("\n")}`)};show();setInterval(show,20000)'
```

Run it from the main checkout (the repository root, not one of the worktrees). It lists every folder in `../ai-sdlc-helper-sdlc/` and refreshes every 20 seconds;
Ctrl+C stops it.

## With `watch`

```bash
watch -n 20 'for d in ../ai-sdlc-helper-sdlc/*/; do echo "== $d"; git -C "$d" log --oneline -1; git -C "$d" status --short | head -8; done'
```

`watch` is not installed everywhere:

| OS | Installed by default | Install |
|---|---|---|
| Debian, Ubuntu | Yes (`procps`) | `sudo apt install procps` |
| Fedora, RHEL, CentOS | Yes (`procps-ng`) | `sudo dnf install procps-ng` |
| Arch | Yes (`procps-ng`) | `sudo pacman -S procps-ng` |
| Alpine | BusyBox's `watch` only | `apk add procps` for the full one |
| macOS | No | `brew install watch`, or `sudo port install watch` |
| Windows | No | Use WSL (`wsl watch ...`), or the PowerShell loop below |

PowerShell:

```powershell
while ($true) { Clear-Host; Get-ChildItem ..\ai-sdlc-helper-sdlc -Directory | ForEach-Object { "== $($_.Name)"; git -C $_.FullName log --oneline -1; git -C $_.FullName status --short | Select-Object -First 8 }; Start-Sleep 20 }
```

A built-in `ai-sdlc-helper watch` command is planned with the worktree and run controls (docs/PLAN.md, phase 4).
